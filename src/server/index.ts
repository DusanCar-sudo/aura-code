import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createProvider, KNOWN_MODELS, apiKeyEnvVarForModel } from '../providers/factory.js';
import { loadProjectContext } from '../agent/context.js';
import { runAgentLoop } from '../agent/loop.js';
import { PermissionSystem } from '../safety/permissions.js';
import { findDeviceByToken, touchDevice, redeemPairingCode } from './devices.js';
import {
  pickLanAddress, ensureLanCert, shortFingerprint, tailscaleAddress, tailscaleDnsName,
} from './lan.js';
import { addEpisode, recentEpisodes } from '../agent/episodic-memory.js';
import { Session } from './session.js';
import { SessionBudget } from '../agent/session-budget.js';
import { ProtocolHandler } from '../protocol/handler.js';
import type { Frame } from '../protocol/types.js';
import { routeTask, createPlan, executePlan } from '../orchestration/index.js';
import type { Display } from '../cli/display.js';
import type { ProviderConfig } from '../providers/types.js';
import { openExternal } from '../util/open.js';
import { loadAllPlugins } from '../plugins/loader.js';
import { installPlugin, removePlugin } from '../plugins/market.js';
import { PALETTE_COMMANDS } from '../cli/command-palette.js';
import { PROVIDER_REGISTRY } from '../setup/provider-registry.js';
import {
  loadBoard, reclaimStrandedTasks, saveAttachment, saveBoard, updateTask,
} from '../board/store.js';

/** Name of the session cookie the browser client authenticates with. */
const AUTH_COOKIE = 'aura_token';

export interface ServeOptions {
  port: number; cwd: string; model: string;
  apiKey?: string; baseUrl?: string; open: boolean;
  /** Also listen on the local network, over TLS, for phones on the same Wi-Fi. */
  lan?: boolean;
  /** Bind this LAN address specifically instead of the auto-detected one. */
  lanAddress?: string;
  /** Also listen on the Tailscale address, reachable from any network. */
  tailscale?: boolean;
  /**
   * Allow the web client to install and remove plugins, and to set provider
   * API keys, over HTTP.
   *
   * Off by default. Installing a plugin downloads and runs code with this
   * process's full privileges and no sandbox (src/plugins/hooks.ts), so over
   * `--lan` or `--tailscale` an enabled endpoint turns any paired device into
   * remote code execution. The pairing token is the only thing in front of it,
   * which is fine for a local convenience and not enough for a standing one.
   */
  allowPluginInstall?: boolean;
  /**
   * Allow the web client to set provider API keys over HTTP.
   *
   * Split from `allowPluginInstall` because the two are not remotely the same
   * risk, and bundling them made the safe one unusable: to type an API key
   * into the settings panel you had to enable arbitrary unsandboxed plugin
   * installation, and the refusal you got talked about plugins rather than
   * keys. Setting a key writes one `process.env` entry, only for a name
   * PROVIDER_REGISTRY declares, never to disk and never readable back.
   *
   * Undefined means the honest default: allowed on a loopback-only bind, where
   * whoever can reach the port is already the person running the server, and
   * refused once `--lan` or `--tailscale` puts it on a network, where the
   * pairing token becomes the only thing in front of a secret-shaped field.
   * `true` and `false` override that either way.
   */
  allowApiKeys?: boolean;
}

/**
 * Whether a bind with these options may accept an API key over HTTP.
 *
 * Extracted from the request handler so the policy can be tested without
 * standing up a server — the decision is the part worth pinning, and it is the
 * part that would silently loosen if someone reordered the conditions.
 */
export function apiKeysAllowedFor(
  opts: Pick<ServeOptions, 'allowApiKeys' | 'lan' | 'tailscale'>,
): boolean {
  // An explicit answer wins in both directions: an operator who typed the flag
  // has made the call, including the paranoid direction on localhost.
  if (opts.allowApiKeys !== undefined) return opts.allowApiKeys;
  // Otherwise: fine on loopback, where reaching the port already means being
  // the user running the server; refused once it is on a network, where the
  // pairing token would be the only thing in front of a secret-shaped field.
  return !opts.lan && !opts.tailscale;
}

export async function startServer(opts: ServeOptions): Promise<void> {
  // Nothing is running the instant the engine starts, so any board task found
  // in `execution` was cut off by whatever ended the last process. Put it back
  // where the user can run it again instead of leaving a tile parked in a
  // column with no control that moves it.
  {
    const state = loadBoard(opts.cwd);
    if (reclaimStrandedTasks(state) > 0) saveBoard(opts.cwd, state);
  }

  const app = express();
  const server = http.createServer(app);

  // The web client drives the agent with the invoking user's full privileges.
  // Without auth it would be reachable by anyone on the LAN (Node binds
  // 0.0.0.0 by default) and drivable cross-origin from any website the user
  // visits (WebSocket hijack). Defenses: bind loopback only, require a
  // per-run bearer token on every route + the WS handshake, and validate the
  // WS Origin so a browser tab on another site can't connect.
  const token = process.env.AURA_SERVER_TOKEN || crypto.randomBytes(24).toString('hex');
  const host = '127.0.0.1';
  const allowedOrigins = new Set([
    `http://localhost:${opts.port}`,
    `http://127.0.0.1:${opts.port}`,
  ]);
  const tokenizedUrl = `http://${host}:${opts.port}/?token=${token}`;

  // ── Optional LAN listener ──────────────────────────────────────────────
  // A second server on the *specific* LAN address, never 0.0.0.0: this
  // machine also has a Tailscale address and a container bridge, and
  // wildcard-binding would publish the agent on both without saying so.
  // TLS-only, because over Wi-Fi the stream is source code and shell output.
  const lanServers: { server: https.Server; address: string; iface: string; kind: string }[] = [];
  let lanFingerprint: string | null = null;

  if (opts.lan || opts.tailscale) {
    const targets: { address: string; iface: string; kind: string }[] = [];

    if (opts.lan || opts.lanAddress) {
      const picked = pickLanAddress(opts.lanAddress);
      if (!picked) {
        throw new Error(
          opts.lanAddress
            ? `No interface has the address ${opts.lanAddress}.`
            : 'No local network interface found — is Wi-Fi connected?',
        );
      }
      targets.push({ ...picked, kind: 'Wi-Fi' });
    }

    if (opts.tailscale) {
      const ts = tailscaleAddress();
      if (!ts) {
        throw new Error(
          'No Tailscale address found — is Tailscale installed and running? '
          + 'Check with `tailscale status`.',
        );
      }
      if (!targets.some(t => t.address === ts.address)) {
        targets.push({ ...ts, kind: 'Tailscale' });
      }
    }

    // One certificate covering every address this machine answers on, so the
    // phone's pin survives moving between Wi-Fi and Tailscale.
    const dnsNames = [tailscaleDnsName()].filter((d): d is string => !!d);
    const { cert, key, fingerprint } = ensureLanCert(targets.map(t => t.address), dnsNames);
    lanFingerprint = fingerprint;

    for (const t of targets) {
      lanServers.push({ server: https.createServer({ cert, key }, app), ...t });
      allowedOrigins.add(`https://${t.address}:${opts.port}`);
    }
    for (const d of dnsNames) allowedOrigins.add(`https://${d}:${opts.port}`);
  }

  /**
   * Who is on the other end.
   *
   * The per-run token is the browser UI's own credential and identifies no
   * particular person, so every holder of it shares one identity. A paired
   * device gets its own, which is what lets two people share this server
   * without sharing a conversation, a budget, or each other's approval
   * prompts.
   */
  interface ClientIdentity { id: string; name: string }

  function identify(provided: string | undefined): ClientIdentity | null {
    if (!provided) return null;
    if (provided === token) return { id: 'local', name: 'this computer' };
    const device = findDeviceByToken(provided);
    return device ? { id: `device:${device.id}`, name: device.name } : null;
  }

  // noServer, because the same WebSocket layer has to serve two listeners:
  // the loopback HTTP server and, when enabled, the TLS LAN server.
  const wss = new WebSocketServer({ noServer: true });

  function handshakeAllowed(req: http.IncomingMessage): boolean {
    // Reject unless the token names a known client and (for browser clients
    // that send one) the Origin is our own page.
    try {
      const reqUrl = new URL(req.url ?? '/', `http://${host}:${opts.port}`);
      if (!identify(reqUrl.searchParams.get('token') ?? undefined)) return false;
    } catch { return false; }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return false;
    return true;
  }

  const onUpgrade = (
    req: http.IncomingMessage,
    socket: import('net').Socket,
    head: Buffer,
  ): void => {
    if (!handshakeAllowed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  };

  server.on('upgrade', onUpgrade);
  for (const l of lanServers) l.server.on('upgrade', onUpgrade);

  app.use(express.json());

  // Auth gate for all HTTP routes \u2014 token via ?token= (initial navigation)
  // or the X-Aura-Token header (API calls from the page).
  // Deliberately ahead of the auth gate: a phone redeeming a pairing code has
  // no token yet — that is the whole point of the exchange. The code itself is
  // the credential here, and it is single-use, short-lived, and attempt-capped
  // (see devices.ts), so this is not an open door.
  app.post('/api/pair', (req, res) => {
    const code = String((req.body as { code?: unknown } | undefined)?.code ?? '');
    if (!code.trim()) {
      res.status(400).json({ error: 'Missing pairing code.' });
      return;
    }
    const paired = redeemPairingCode(code);
    if (!paired) {
      // Same answer for unknown, expired, and exhausted: distinguishing them
      // would tell a guesser which codes are worth continuing to try.
      res.status(401).json({ error: 'That pairing code is not valid. Generate a new one with `aura devices add`.' });
      return;
    }
    console.log(`\n  Paired "${paired.device.name}" (${paired.device.id})\n`);
    res.json({ token: paired.token, device: { id: paired.device.id, name: paired.device.name } });
  });

  /**
   * Read the session cookie.
   *
   * The web client is a real page with its own asset and API requests, and a
   * browser attaches neither a query string nor a custom header to a <script>
   * it was told to fetch. Without a cookie every asset 401s and the page
   * renders blank — which is exactly what happened. The cookie is set below,
   * only after a valid token arrived by query or header, so it grants nothing
   * that was not already granted.
   */
  function cookieToken(req: express.Request): string | undefined {
    const raw = req.header('cookie');
    if (!raw) return undefined;
    for (const part of raw.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === AUTH_COOKIE) return decodeURIComponent(rest.join('='));
    }
    return undefined;
  }

  app.use((req, res, next) => {
    const explicit = (req.query.token as string | undefined) ?? req.header('x-aura-token');
    const provided = explicit ?? cookieToken(req);
    const who = identify(provided);
    if (!who) {
      res.status(401).send('Unauthorized: missing or invalid token.');
      return;
    }
    // Promote a proven token to a cookie so the page's own subresources
    // authenticate. httpOnly keeps it away from page scripts; SameSite=Strict
    // keeps another origin from riding it; Secure only under TLS, since the
    // default bind is plain http on loopback where Secure would drop it.
    if (explicit && explicit === provided) {
      res.cookie?.(AUTH_COOKIE, explicit, {
        httpOnly: true,
        sameSite: 'strict',
        secure: req.protocol === 'https',
        maxAge: 12 * 60 * 60 * 1000,
        path: '/',
      });
    }
    // Carried so /api/history and /api/reset act on the caller's own
    // conversation instead of a single shared one.
    (req as express.Request & { auraClient?: ClientIdentity }).auraClient = who;
    next();
  });

  function clientOf(req: express.Request): ClientIdentity {
    // The gate above rejects anything unidentified, so this is always set.
    return (req as express.Request & { auraClient?: ClientIdentity }).auraClient!;
  }

  const ctx = await loadProjectContext(opts.cwd);

  /**
   * Conversation and spend, per client.
   *
   * These used to be one shared pair. With two phones paired that means one
   * person's turns enter the other's context and one person's usage exhausts
   * the other's ceiling, so they are keyed by identity. The project context
   * stays shared — it describes the checkout, which genuinely is common.
   *
   * The budget is the spend ceiling the CLI paths already apply
   * (cli/index.ts:631, :1361); without it runAgentLoop enforces none at all.
   * Defaults to AURA_SESSION_BUDGET, else DEFAULT_MAX_INPUT_TOKENS. Reset
   * alongside the conversation it bounds.
   */
  interface ClientState { session: Session; budget: SessionBudget }
  /**
   * Every open socket, so an HTTP route can tell the browsers something.
   *
   * Each connection builds its own ProtocolHandler, which can only answer the
   * socket it belongs to. The attachment upload arrives over HTTP but changes
   * the board, and a second window must not keep showing a task without the
   * file that was just added to it — so that one change is announced to all.
   */
  const sockets = new Set<WebSocket>();
  const broadcast = (frame: unknown) => {
    const line = JSON.stringify(frame);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(line);
    }
  };

  const clients = new Map<string, ClientState>();

  function stateFor(who: ClientIdentity): ClientState {
    let state = clients.get(who.id);
    if (!state) {
      state = { session: new Session(), budget: new SessionBudget({}) };
      clients.set(who.id, state);
    }
    return state;
  }

  console.log('\n  Aura \u2014 web client');
  console.log('  Project : ' + ctx.name + ' \u00b7 ' + ctx.language);
  console.log('  Model   : ' + opts.model);
  console.log('  URL     : ' + tokenizedUrl);
  console.log('  (bound to 127.0.0.1; the URL includes a single-session access token)');
  for (const l of lanServers) {
    console.log(`\n  ${l.kind.padEnd(9)}: ${l.address}:${opts.port}  (${l.iface}, TLS)`);
  }
  if (lanFingerprint) {
    console.log('  Identity : ' + shortFingerprint(lanFingerprint)
      + '   \u2190 the phone shows this after pairing; they must match');
    console.log('  Reaching the port is not enough \u2014 a pairing code from');
    console.log('  `aura devices add` is still required to get in.');
  }
  console.log('');

  // ── Web client ───────────────────────────────────────────────────────────
  // dist/web is the built React client (npm run build:web). When it is absent
  // — a source checkout that has not built the web assets — fall back to the
  // original inline UI rather than serving a blank page.
  const webDir = path.join(__dirname, '..', 'web');
  const hasWebClient = fs.existsSync(path.join(webDir, 'index.html'));

  if (hasWebClient) {
    // Assets only: '/' stays a handler below so the pairing token can be
    // injected into the URL the browser actually loads.
    // Assets are content-hashed, so they are immutable and cache hard.
    app.use(express.static(webDir, { index: false, immutable: true, maxAge: '365d' }));
  }

  app.get('/', (_req, res) => {
    if (hasWebClient) {
      res.setHeader('Content-Type', 'text/html');
      // Never cached: it is the document that names the current asset hashes,
      // so a stale copy pins the browser to a previous build.
      res.setHeader('Cache-Control', 'no-store');
      res.send(fs.readFileSync(path.join(webDir, 'index.html'), 'utf8'));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(buildUI(ctx.name, opts.model, token));
  });

  /**
   * Skills and plugins, for the settings panel's loader.
   *
   * Read-only by design: listing what is installed is safe, whereas installing
   * over the network is not — plugins run unsandboxed with the operator's full
   * privileges (see src/plugins/hooks.ts), so that stays a deliberate local act.
   */
  app.get('/api/skills', (_req, res) => {
    try {
      const skills = loadAllPlugins().flatMap((plugin) =>
        plugin.skills.map((skill) => ({
          id: `${plugin.name}:${skill.name}`,
          name: skill.name,
          description: skill.description,
          source: plugin.name,
        })));
      res.json({ skills });
    } catch {
      res.json({ skills: [] });
    }
  });

  /**
   * The command set the TUI exposes, so the web client's "/" menu is the same
   * list rather than a copy that drifts. Served from PALETTE_COMMANDS itself.
   */
  app.get('/api/commands', (_req, res) => {
    res.json({ commands: PALETTE_COMMANDS });
  });

  /**
   * Providers, their models, and WHETHER a key is configured.
   *
   * Never the key itself: this endpoint answers "is it set", never "what is
   * it". A settings screen only needs the boolean, and echoing a secret back
   * over the wire to render it would be a way to lose it.
   */

  /**
   * Attach a file or image to a board task.
   *
   * Its own body limit: the global express.json() cap is 100kb, which any
   * screenshot exceeds, and raising it globally would let every other endpoint
   * accept 25MB of JSON too. The file is written to disk beside the board and
   * the task keeps only the path — see BoardAttachment on why bytes never go
   * into the board file.
   *
   * Not gated behind the API-key or plugin flags: writing a file the user just
   * picked into the user's own state directory is what they asked for, and it
   * grants the agent nothing it did not already have — it can read the whole
   * project anyway.
   */
  app.post('/api/board/attach', express.json({ limit: '25mb' }), (req, res) => {
    const body = (req.body ?? {}) as {
      taskId?: unknown; name?: unknown; type?: unknown; dataUrl?: unknown; projectRoot?: unknown;
    };
    const taskId = typeof body.taskId === 'string' ? body.taskId : '';
    const name = typeof body.name === 'string' ? body.name : '';
    const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
    if (!taskId || !name || !dataUrl) {
      res.status(400).json({ error: 'taskId, name and dataUrl are required.' });
      return;
    }
    // `data:<mime>;base64,<payload>` — anything else is not something a file
    // picker produced, so refuse rather than guess at the encoding.
    const comma = dataUrl.indexOf(',');
    if (!dataUrl.startsWith('data:') || !dataUrl.slice(0, comma).includes('base64') || comma < 0) {
      res.status(400).json({ error: 'dataUrl must be a base64 data URL.' });
      return;
    }

    const root = typeof body.projectRoot === 'string' && body.projectRoot
      ? body.projectRoot : opts.cwd;
    const state = loadBoard(root);
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) {
      res.status(404).json({ error: `No task with id "${taskId}".` });
      return;
    }

    try {
      const data = Buffer.from(dataUrl.slice(comma + 1), 'base64');
      const attachment = saveAttachment(root, taskId, {
        name,
        type: typeof body.type === 'string' ? body.type : 'application/octet-stream',
        data,
      });
      updateTask(state, taskId, { attachments: [...(task.attachments ?? []), attachment] });
      saveBoard(root, state);
      broadcast({ kind: 'evt', method: 'board.changed', params: { projectRoot: root, tasks: state.tasks } });
      res.json({ ok: true, attachment });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/api/providers', (_req, res) => {
    res.json({
      providers: PROVIDER_REGISTRY.map((entry) => ({
        name: entry.name,
        baseUrl: entry.baseUrl,
        envKey: entry.envKey,
        signupUrl: entry.signupUrl,
        keySet: entry.envKey ? Boolean(process.env[entry.envKey]?.trim()) : true,
        models: entry.models.map((m) => ({
          id: m.id, label: m.label, speed: m.speed, contextWindow: m.contextWindow,
        })),
      })),
      // So the panel can say why the field is unavailable instead of offering
      // an input that answers every save with a 403.
      apiKeysWritable: apiKeysAllowed(),
      // Which registry entry the model this server is actually running belongs
      // to. Without it the settings panel could not identify the provider in
      // use — it matched on model-id suffix, which fails for any routed id
      // like `fpt/Z.ai:GLM-5.3`, so it showed no provider selected and hid the
      // API-key field entirely on a perfectly working setup.
      activeEnvKey: apiKeyEnvVarForModel(opts.model) ?? null,
    });
  });

  /**
   * Set a provider API key for this running engine.
   *
   * Process-scoped on purpose — it is not written to disk, so closing the
   * server forgets it. Persisting a pasted secret is the operator's decision to
   * make in their own environment, not something a web form should do quietly.
   * The value is never logged and never read back.
   */
  /**
   * Mutating extension endpoints are gated: see ServeOptions.allowPluginInstall.
   * Refusing with 403 and the flag name beats a silent 404 — the operator
   * should learn the capability exists and is deliberately off.
   */
  function requireMutationsAllowed(res: express.Response): boolean {
    if (opts.allowPluginInstall) return true;
    res.status(403).json({
      error: 'Plugin install and removal are disabled. '
        + 'Restart with `aura serve --allow-plugin-install` to enable them. '
        + 'Plugins run unsandboxed with full privileges, so this is off by default.',
    });
    return false;
  }

  const apiKeysAllowed = () => apiKeysAllowedFor(opts);

  function requireApiKeysAllowed(res: express.Response): boolean {
    if (apiKeysAllowed()) return true;
    res.status(403).json({
      error: 'Setting API keys over HTTP is disabled while the server is reachable '
        + 'from the network. Restart with `aura serve --allow-api-keys` to allow it, '
        + 'or set the key in the environment before starting the server.',
    });
    return false;
  }

  app.post('/api/apikey', (req, res) => {
    if (!requireApiKeysAllowed(res)) return;
    const body = (req.body ?? {}) as { envKey?: unknown; value?: unknown };
    const envKey = typeof body.envKey === 'string' ? body.envKey.trim() : '';
    const value = typeof body.value === 'string' ? body.value.trim() : '';
    // Only keys the registry actually declares — this must not become a
    // general "set any environment variable on the host" endpoint.
    const known = PROVIDER_REGISTRY.some((e) => e.envKey === envKey);
    if (!known || !/^[A-Z0-9_]+$/.test(envKey)) {
      res.status(400).json({ error: 'Unknown API key name.' });
      return;
    }
    if (!value) {
      delete process.env[envKey];
      res.json({ ok: true, keySet: false });
      return;
    }
    process.env[envKey] = value;
    res.json({ ok: true, keySet: true });
  });

  /**
   * Install a plugin. Accepts anything installPlugin does: a marketplace name,
   * owner/repo, a git URL, or a local path — which is what makes the loader
   * source-agnostic.
   *
   * Plugins run unsandboxed with this process's privileges (src/plugins/hooks.ts),
   * so this route is as dangerous as the CLI equivalent. It is reachable only
   * behind the pairing token on a loopback bind by default; that is the whole
   * of its protection, and the UI says so plainly.
   */
  app.post('/api/plugins/install', async (req, res) => {
    if (!requireMutationsAllowed(res)) return;
    const spec = typeof (req.body as { spec?: unknown })?.spec === 'string'
      ? String((req.body as { spec: string }).spec).trim()
      : '';
    if (!spec) {
      res.status(400).json({ error: 'Missing plugin source.' });
      return;
    }
    try {
      const result = await installPlugin(spec);
      res.json({
        ok: true,
        plugin: { id: result.plugin.name, name: result.plugin.manifest.name || result.plugin.name },
        warnings: result.warnings,
      });
    } catch (e) {
      res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
    }
  });

  app.post('/api/plugins/remove', (req, res) => {
    if (!requireMutationsAllowed(res)) return;
    const name = typeof (req.body as { name?: unknown })?.name === 'string'
      ? String((req.body as { name: string }).name).trim()
      : '';
    // Reject any path shape: this deletes a directory, so the name must be a
    // plain plugin id and never a traversal.
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
      res.status(400).json({ error: 'Invalid plugin name.' });
      return;
    }
    res.json({ ok: removePlugin(name) });
  });

  app.get('/api/plugins', (_req, res) => {
    try {
      const plugins = loadAllPlugins().map((plugin) => ({
        id: plugin.name,
        name: plugin.manifest.name || plugin.name,
        description: plugin.manifest.description,
        source: plugin.path,
        commands: plugin.commands.length,
        skills: plugin.skills.length,
        hooks: plugin.hooks.length,
      }));
      res.json({ plugins });
    } catch {
      res.json({ plugins: [] });
    }
  });
  app.get('/api/history', (req, res) => res.json(stateFor(clientOf(req)).session.getDisplay()));
  app.get('/api/project', (req, res) => res.json({
    name: ctx.name, language: ctx.language, model: opts.model, models: KNOWN_MODELS,
    // Lets a phone show which device it is paired as, so two people sharing
    // a desktop can tell whose client they are looking at.
    device: clientOf(req).name,
  }));
  /**
   * Memos recorded on a phone, filed into episodic memory.
   *
   * The phone is where thinking-aloud happens; the desktop is where the agent
   * can search it. Idempotent by the phone's own id, so a re-sync after a
   * dropped connection does not leave the same memo in recall three times.
   */
  app.post('/api/memo', (req, res) => {
    const body = (req.body ?? {}) as {
      id?: unknown; text?: unknown; title?: unknown; at?: unknown; tags?: unknown;
    };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'Missing text.' });
      return;
    }
    const episode = addEpisode({
      id: typeof body.id === 'string' ? body.id : undefined,
      kind: 'memo',
      title: typeof body.title === 'string' ? body.title : undefined,
      text,
      at: typeof body.at === 'string' ? body.at : undefined,
      // Tagged with the device so recall can say where a thought came from.
      tags: [
        ...(Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : []),
        clientOf(req).name,
      ],
    });
    res.json({ id: episode.id, title: episode.title });
  });

  app.get('/api/memos', (_req, res) => res.json(recentEpisodes(50)));

  app.post('/api/reset', (req, res) => {
    const state = stateFor(clientOf(req));
    state.session.reset();
    state.budget.reset();
    res.json({ ok: true });
  });

  // ── Remote tool approval ───────────────────────────────────────────────
  // Without this, PermissionSystem('normal') falls back to confirm(), which
  // reads the *server's* stdin — so a remote client asking for a file write
  // blocks on a y/N prompt it cannot see, and hangs forever when the server
  // runs headless (systemd). Route the prompt to the client that asked.
  //
  // The pending map is per connection, created below. A server-wide map keyed
  // by uuid would let one client answer a prompt raised by another's run
  // simply by echoing back an id it observed.
  const CONFIRM_TIMEOUT_MS = 120_000;

  function askClient(
    ws: WebSocket,
    pendingConfirms: Map<string, (approved: boolean) => void>,
    message: string,
  ): Promise<boolean> {
    if (ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    const id = crypto.randomUUID();
    return new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (approved: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingConfirms.delete(id);
        resolve(approved);
      };
      // Deny on silence rather than blocking the agent indefinitely.
      const timer = setTimeout(() => {
        send(ws, { type: 'confirm_timeout', id });
        finish(false);
      }, CONFIRM_TIMEOUT_MS);
      pendingConfirms.set(id, finish);
      send(ws, { type: 'confirm_request', id, message });
    });
  }

  wss.on('connection', (ws, req) => {
    // verifyClient already rejected anything unidentified, so re-deriving the
    // identity here cannot fail — but fall back to the local identity rather
    // than crashing the connection if the URL is somehow unparseable.
    let who: ClientIdentity = { id: 'local', name: 'this computer' };
    try {
      const reqUrl = new URL(req.url ?? '/', `http://${host}:${opts.port}`);
      who = identify(reqUrl.searchParams.get('token') ?? undefined) ?? who;
    } catch { /* keep the fallback */ }
    if (who.id.startsWith('device:')) touchDevice(who.id.slice('device:'.length));

    const state = stateFor(who);
    send(ws, { type: 'connected' });

    // Approvals belong to this socket alone. Previously this registered a
    // process-global handler, so the client that connected most recently
    // received *everyone's* prompts — your mother's phone could be asked to
    // approve a shell command your agent wanted to run — and any client
    // hanging up cleared the handler for whoever was still connected,
    // silently dropping the agent back to the desktop's unread stdin.
    const pendingConfirms = new Map<string, (approved: boolean) => void>();
    const confirmFn = (message: string): Promise<boolean> => askClient(ws, pendingConfirms, message);

    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));

    // Protocol handler for frame-shaped clients (aura-droid and any other
    // non-browser consumer). The built-in browser UI still speaks the older
    // `type:`-tagged messages below, so the two are dispatched by shape:
    // a `kind` field means a protocol frame, `type` means the legacy path.
    // Same socket, same auth, one message schema shared with `aura sidecar`.
    const protocol = new ProtocolHandler({
      defaultModel: opts.model,
      defaultApiKey: opts.apiKey,
      defaultBaseUrl: opts.baseUrl,
      defaultProjectRoot: opts.cwd,
      send: (frame) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)); },
    });

    ws.on('message', async (raw) => {
      let msg: {
        kind?: string;
        type: string; task?: string; model?: string; id?: string; approved?: boolean;
      };
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.kind === 'req' || msg.kind === 'res' || msg.kind === 'evt') {
        await protocol.handle(msg as unknown as Frame);
        return;
      }

      if (msg.type === 'confirm_response' && typeof msg.id === 'string') {
        pendingConfirms.get(msg.id)?.(msg.approved === true);
        return;
      }
      if (msg.type === 'task' && msg.task) {
        await runTask(ws, state, confirmFn, msg.task, msg.model ?? opts.model);
      }
      if (msg.type === 'reset') {
        // The budget bounds one conversation, and reset starts a new one —
        // carrying the old total forward would leave every later conversation
        // starting already exhausted. Same rationale as SessionBudget.reset().
        state.session.reset();
        state.budget.reset();
        send(ws, { type: 'reset_ok' });
      }
      if (msg.type === 'usage') {
        send(ws, {
          type: 'usage',
          inputTokensUsed: state.budget.inputTokensUsed,
          maxInputTokens: state.budget.maxInputTokens,
          turnsUsed: state.budget.turnsUsed,
        });
      }
    });

    ws.on('close', () => {
      protocol.dispose();
      // Deny anything still waiting on *this* socket — nobody is left to
      // answer it. Other clients' prompts live in their own maps and are
      // deliberately untouched.
      for (const resolve of pendingConfirms.values()) resolve(false);
      pendingConfirms.clear();
    });
  });

  async function runTask(
    ws: WebSocket,
    state: ClientState,
    confirmFn: (message: string) => Promise<boolean>,
    task: string,
    model: string,
  ): Promise<void> {
    const { session, budget } = state;
    session.addUser(task);
    let provider;
    try { provider = createProvider({ model, apiKey: opts.apiKey, baseUrl: opts.baseUrl } as ProviderConfig); }
    catch (e) { send(ws, { type: 'error', message: String(e) }); return; }

    const display: Display = {
      agentThinking: () => send(ws, { type: 'thinking' }),
      streamText: (t) => send(ws, { type: 'text', text: t }),
      streamEnd: () => send(ws, { type: 'text_end' }),
      toolStart: () => {},
      toolCall: (name, input) => send(ws, { type: 'tool_call', name, input }),
      toolResult: (name, result, ms) => send(ws, { type: 'tool_result', name, result, ms }),
      toolBlocked: (name, reason) => send(ws, { type: 'tool_blocked', name, reason }),
      warning: (msg) => send(ws, { type: 'warning', message: msg }),
      success: () => {},
      error: (msg) => send(ws, { type: 'error', message: msg }),
      header: () => {},
      summary: (text, turns, toolCount) => send(ws, { type: 'done', text, turns, toolCount, success: true }),
      showPlan: (plan) => send(ws, { type: 'plan_created', plan }),
      stepStarted: (step) => send(ws, { type: 'step_started', step }),
      stepCompleted: (step, result) => send(ws, { type: 'step_completed', step, result }),
      contextBar: (health) => send(ws, { type: 'context_bar', health }),
      contextDashboard: (health) => send(ws, { type: 'context_dashboard', health }),
      compactionEvent: (info) => send(ws, { type: 'compaction', ...info }),
      artifact: (a) => send(ws, { type: 'artifact', ...a }),
    };

    // Try orchestration first
    try {
      const decision = await routeTask({ provider, context: ctx, task });
      if (decision.shouldDecompose) {
        send(ws, { type: 'plan_creating' });
        const plan = await createPlan({ provider, context: ctx, task });
        send(ws, { type: 'plan_created', plan });

        const executedPlan = await executePlan({ provider, context: ctx, plan, display, confirmFn });
        const text = executedPlan.outcome ?? 'Plan completed.';
        const success = executedPlan.status === 'done';
        send(ws, { type: 'plan_done', outcome: text, success });
        session.addAssistant(text, executedPlan.steps.length, 0);
        return;
      }
    } catch {
      // Orchestration failed — fall through to single agent
    }

    // Single agent (existing behaviour)
    const result = await runAgentLoop({
      provider, task, context: ctx,
      permissions: new PermissionSystem('normal'), display,
      budget,
      confirmFn,
    });
    session.addAssistant(result.summary, result.turns, result.toolCallCount);
    send(ws, { type: 'done', success: result.success, text: result.summary, turns: result.turns, toolCount: result.toolCallCount });
  }

  server.listen(opts.port, host, () => {
    if (opts.open) openExternal(tokenizedUrl);
    console.log('  Ready \u2192 ' + tokenizedUrl + '  (Ctrl+C to stop)\n');
  });

  for (const l of lanServers) {
    l.server.listen(opts.port, l.address, () => {
      console.log(`  Ready \u2192 https://${l.address}:${opts.port}  (${l.kind}, phones)\n`);
    });
  }
}

function send(ws: WebSocket, data: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function buildUI(project: string, defaultModel: string, token: string): string {
  const modelOpts = KNOWN_MODELS
    .map(m => `<option value="${m.id}">${m.provider} \u2014 ${m.name}</option>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${project} \u2014 Aura</title>
<style>
:root{
  --bg:#0e0a06;--bg2:#150e08;--s:#1c1208;--ink:#ede0cc;--inks:#c8b5a0;
  --m:#8a7768;--f:#4e3d30;--c:#cc785c;--cd:#b15439;--g:#5a9e6e;
  --l:#2c1e14;--l2:#3a2818;--ti:rgba(204,120,92,.12);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg);color:var(--ink);font-family:system-ui,sans-serif;font-size:14px;overflow:hidden}
.app{display:grid;grid-template-rows:52px 1fr 76px;height:100vh}
.bar{background:var(--bg2);border-bottom:1px solid var(--l2);display:flex;align-items:center;gap:12px;padding:0 20px}
.logo{font-family:Georgia,serif;font-size:17px;font-weight:600}
.logo em{font-style:italic;color:var(--c)}
.proj{font-family:monospace;font-size:11px;color:var(--m)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--f);flex-shrink:0;transition:.3s}
.dot.on{background:var(--g);box-shadow:0 0 0 3px rgba(90,158,110,.2)}
select{margin-left:auto;background:var(--s);border:1px solid var(--l2);color:var(--inks);border-radius:6px;padding:6px 10px;font-size:11px}
.btn-r{font-size:11px;color:var(--m);background:transparent;border:1px solid var(--l2);border-radius:5px;padding:5px 10px;cursor:pointer}
.btn-r:hover{border-color:var(--c);color:var(--c)}
.chat{overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:10px}
.ibar{background:var(--bg2);border-top:1px solid var(--l2);padding:14px 18px;display:flex;gap:10px;align-items:flex-end}
.iw{flex:1;background:var(--s);border:1px solid var(--l2);border-radius:12px;display:flex;align-items:flex-end;padding:8px 12px;gap:10px;transition:.2s}
.iw:focus-within{border-color:var(--c);box-shadow:0 0 0 2px rgba(204,120,92,.15)}
#inp{flex:1;background:transparent;border:none;outline:none;color:var(--ink);font-size:14px;resize:none;max-height:130px;line-height:1.5;padding:4px 0}
#inp::placeholder{color:var(--f)}
#sb{background:var(--c);color:#fff;border:none;border-radius:8px;width:36px;height:36px;cursor:pointer;font-size:18px;flex-shrink:0;transition:.2s}
#sb:hover{background:var(--cd)}
#sb:disabled{background:var(--f);cursor:not-allowed}
.mu{display:flex;justify-content:flex-end}
.mu .b{background:var(--ti);border:1px solid rgba(204,120,92,.2);border-radius:14px 14px 4px 14px;padding:11px 16px;max-width:75%;line-height:1.55}
.ma .b{background:var(--s);border:1px solid var(--l2);border-radius:4px 14px 14px 14px;padding:13px 16px;color:var(--inks);line-height:1.65;white-space:pre-wrap}
.mt{background:#1a1008;border:1px solid var(--l);border-left:2px solid var(--c);border-radius:6px;padding:9px 13px;font-family:monospace;font-size:12px}
.tn{color:var(--c);font-weight:700;margin-bottom:3px}
.ti{color:var(--m)}
.tr{color:var(--inks);margin-top:5px;padding-top:5px;border-top:1px solid var(--l);font-size:11px;white-space:pre-wrap;max-height:90px;overflow-y:auto}
.sy{font-family:monospace;font-size:11px;color:#d4903a;text-align:center;padding:4px}
.tk{display:flex;align-items:center;gap:8px;font-family:monospace;font-size:11px;color:var(--m);padding:6px 0}
.tk::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--c);flex-shrink:0;animation:p 1.2s infinite}
.sk{background:var(--s);border:1px solid var(--l2);border-left:2px solid var(--c);border-radius:6px;padding:13px 16px;color:var(--inks);line-height:1.65;white-space:pre-wrap}
.cur{display:inline-block;width:8px;height:14px;background:var(--c);margin-left:2px;animation:bk 1s steps(1) infinite;vertical-align:text-bottom}
.cf{background:#1a1008;border:1px solid var(--l2);border-left:2px solid #d4903a;border-radius:8px;padding:12px 15px;margin:4px 0}
.cfm{color:var(--ink);font-size:13px;line-height:1.5;margin-bottom:10px}
.cfb{display:flex;gap:8px;align-items:center}
.cfb button{border:none;border-radius:6px;padding:6px 16px;font-size:12px;font-weight:600;cursor:pointer}
.cfy{background:var(--g);color:#fff}
.cfn{background:var(--f);color:var(--ink)}
.cfa{color:var(--g);font-size:12px;font-family:monospace}
.cfd{color:var(--cd);font-size:12px;font-family:monospace}
.plc{border:1px solid var(--l2);border-radius:10px;padding:14px 16px;margin:4px 0}
.plh{color:var(--c);font-weight:700;font-size:13px;margin-bottom:8px}
.plg{color:var(--m);font-size:12px;margin-bottom:10px}
.ps{display:flex;align-items:flex-start;gap:8px;padding:6px 0;font-size:12px;border-bottom:1px solid var(--l);color:var(--inks)}
.ps:last-child{border-bottom:none}
.ps .psi{width:20px;height:20px;border-radius:50%;text-align:center;line-height:20px;font-size:11px;flex-shrink:0;margin-top:1px}
.ps.wait .psi{background:var(--f);color:var(--m)}
.ps.running .psi{background:#d4903a;color:#fff;animation:p 1.2s infinite}
.ps.done .psi{background:var(--g);color:#fff}
.ps.failed .psi{background:var(--cd);color:#fff}
.ps .psb{flex:1}
.ps .pss{font-weight:600;color:var(--inks)}
.ps .pst{color:var(--m);font-size:11px}
.ps .psr{font-size:10px;color:var(--g);margin-top:2px}
@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes bk{0%,100%{opacity:1}50%{opacity:0}}
</style>
</head>
<body>
<div class="app">
  <div class="bar">
    <div class="logo">Aura</div>
    <div class="proj">${project}</div>
    <div class="dot" id="dot"></div>
    <select id="ms">${modelOpts}</select>
    <button class="btn-r" id="btnR">New chat</button>
  </div>
  <div class="chat" id="ch"></div>
  <div class="ibar">
    <div class="iw">
      <textarea id="inp" rows="1" placeholder="Ask anything about your code\u2026"></textarea>
      <button id="sb">\u2191</button>
    </div>
  </div>
</div>
<script>
(function() {
  var ch = document.getElementById('ch');
  var inp = document.getElementById('inp');
  var sb = document.getElementById('sb');
  var dot = document.getElementById('dot');
  var ms = document.getElementById('ms');
  var btnR = document.getElementById('btnR');

  ms.value = '${defaultModel}';
  if (!ms.value) ms.selectedIndex = 0;

  var TOKEN = ${JSON.stringify(token)};

  var ws, busy = false, sEl = null, sText = '', tEl = null, pEl = null;

  function conn() {
    ws = new WebSocket('ws://' + location.host + '/?token=' + encodeURIComponent(TOKEN));
    ws.onopen = function() { dot.className = 'dot on'; lh(); };
    ws.onclose = function() { dot.className = 'dot'; setTimeout(conn, 2000); };
    ws.onmessage = function(e) { hv(JSON.parse(e.data)); };
  }

  function hv(d) {
    if (d.type === 'plan_creating') { pEl = mk('div','plc'); pEl.innerHTML = '<div class="plh">Orchestrator</div><div class="plg">Creating execution plan\u2026</div>'; ch.appendChild(pEl); sc(); return; }
    if (d.type === 'plan_created') { rp(d.plan); sc(); return; }
    if (d.type === 'step_started') { us(d.step); sc(); return; }
    if (d.type === 'step_completed') { uf(d.step, d.result); sc(); return; }
    if (d.type === 'plan_done') { idle(); if (d.outcome) { var e = mk('div','ma'); e.innerHTML = '<div class="b">' + ex(d.outcome) + '</div>'; ch.appendChild(e); } fn(); sc(); return; }
    if (d.type === 'thinking') { rt(); var e = mk('div','tk'); e.id = 'thi'; e.textContent = 'thinking\u2026'; ch.appendChild(e); sc(); return; }
    if (d.type === 'text') { rt(); if (!sEl) { sEl = mk('div','sk'); ch.appendChild(sEl); } sText += d.text; sEl.innerHTML = ex(sText) + '<span class="cur"></span>'; sc(); return; }
    if (d.type === 'text_end' || d.type === 'done') { fn(); if (d.type === 'done') idle(); sc(); return; }
    if (d.type === 'tool_call') { rt(); var e = mk('div','mt'); e.innerHTML = '<div class="tn">' + ic(d.name) + ' ' + d.name + '</div><div class="ti">' + ex(si(d.name, d.input)) + '</div><div class="tr">running\u2026</div>'; ch.appendChild(e); tEl = e; sc(); return; }
    if (d.type === 'tool_result') { if (tEl) { var r = tEl.querySelector('.tr'), ls = d.result.split('\\n'); r.textContent = ls.length > 5 ? ls.slice(0,5).join('\\n') + '\\n\u2026(+' + (ls.length-5) + ' lines)' : d.result; } tEl = null; return; }
    if (d.type === 'confirm_request') { cfr(d.id, d.message); sc(); return; }
    if (d.type === 'confirm_timeout') { var t = document.getElementById('cf-' + d.id); if (t) { t.querySelector('.cfb').innerHTML = '<span class="cfd">timed out — denied</span>'; } return; }
    if (d.type === 'tool_blocked') { var e = mk('div','sy'); e.textContent = 'blocked: ' + (d.name||'') + ' — ' + (d.reason||''); ch.appendChild(e); sc(); return; }
    if (d.type === 'error' || d.type === 'warning') { var e = mk('div','sy'); e.textContent = d.message || d.reason || ''; ch.appendChild(e); if (d.type === 'error') idle(); sc(); return; }
    if (d.type === 'reset_ok') { ch.innerHTML = ''; }
  }

  // Approval prompt — the agent is blocked until one of these is clicked
  // (or it times out server-side and denies).
  function cfr(id, message) {
    var e = mk('div','cf'); e.id = 'cf-' + id;
    e.innerHTML = '<div class="cfm">' + ex(message) + '</div>'
      + '<div class="cfb"><button class="cfy">Allow</button><button class="cfn">Deny</button></div>';
    ch.appendChild(e);
    function answer(ok) {
      ws.send(JSON.stringify({ type: 'confirm_response', id: id, approved: ok }));
      e.querySelector('.cfb').innerHTML = ok
        ? '<span class="cfa">allowed</span>'
        : '<span class="cfd">denied</span>';
    }
    e.querySelector('.cfy').onclick = function() { answer(true); };
    e.querySelector('.cfn').onclick = function() { answer(false); };
  }

  function rp(plan) {
    if (!pEl) pEl = mk('div','plc');
    var h = '<div class="plh">Execution Plan</div><div class="plg">' + ex(plan.goal||'') + '</div>';
    for (var i = 0; i < (plan.steps||[]).length; i++) {
      var s = plan.steps[i];
      var cls = s.specialist === 'researcher' ? 'R' : s.specialist === 'coder' ? 'C' : s.specialist === 'reviewer' ? 'V' : 'P';
      h += '<div class="ps wait" id="ps-' + s.id + '"><div class="psi">' + cls + '</div><div class="psb"><div class="pss">[' + s.specialist + '] ' + ex(s.task||'') + '</div></div></div>';
    }
    pEl.innerHTML = h;
  }

  function us(step) {
    var e = document.getElementById('ps-' + step.id);
    if (e) { e.className = 'ps running'; e.querySelector('.psi').textContent = '\u2026'; }
  }

  function uf(step, result) {
    var e = document.getElementById('ps-' + step.id);
    if (e) {
      e.className = result ? 'ps done' : 'ps failed';
      var cls = step.specialist === 'researcher' ? 'R' : step.specialist === 'coder' ? 'C' : step.specialist === 'reviewer' ? 'V' : 'P';
      e.querySelector('.psi').textContent = '\\u2713';
      if (result) {
        var re = mk('div','psr'); re.textContent = String(result||'').slice(0,120); e.appendChild(re);
      }
    }
  }

  function rt() { var t = document.getElementById('thi'); if (t) t.remove(); }
  function fn() { rt(); if (sEl && sText) { var d = mk('div','ma'); d.innerHTML = '<div class="b">' + ex(sText) + '</div>'; sEl.replaceWith(d); } else if (sEl) sEl.remove(); sEl = null; sText = ''; tEl = null; }
  function idle() { busy = false; sb.disabled = false; }
  function mk(tag, cls) { var e = document.createElement(tag); e.className = cls; return e; }
  function ex(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function sc() { ch.scrollTop = ch.scrollHeight; }
  function ic(n) { return ({read_file:'\ud83d\udcc4',list_dir:'\ud83d\udcc1',edit_file:'\u270f\ufe0f',write_file:'\ud83d\udcdd',search_code:'\ud83d\udd0d',run_shell:'\u26a1',run_tests:'\ud83e\uddea',git_status:'\ud83c\udf3f',git_diff:'\ud83d\udcca'})[n] || '\ud83d\udd27'; }
  function si(n, i) { if (n==='read_file') return (i.path||'') + (i.start_line ? ':'+i.start_line+'-'+(i.end_line||'?') : ''); if (n==='run_shell') return '$ ' + (i.command||''); if (n==='search_code') return '"' + (i.pattern||'') + '"'; return i.path || JSON.stringify(i).slice(0,60); }

  function go() {
    var t = inp.value.trim();
    if (!t || busy) return;
    var e = mk('div','mu'); e.innerHTML = '<div class="b">' + ex(t) + '</div>'; ch.appendChild(e);
    inp.value = ''; ar(); busy = true; sb.disabled = true;
    ws.send(JSON.stringify({ type: 'task', task: t, model: ms.value }));
    sc();
  }

  function ar() { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 130) + 'px'; }

  function authFetch(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, { 'X-Aura-Token': TOKEN });
    return fetch(url, opts);
  }

  async function lh() {
    var msgs = await authFetch('/api/history').then(function(r) { return r.json(); });
    msgs.forEach(function(m) {
      if (m.role === 'user') { var e = mk('div','mu'); e.innerHTML = '<div class="b">' + ex(m.content) + '</div>'; ch.appendChild(e); }
      else if (m.role === 'assistant' && m.content) { var e = mk('div','ma'); e.innerHTML = '<div class="b">' + ex(m.content) + '</div>'; ch.appendChild(e); }
    });
    sc();
  }

  sb.addEventListener('click', go);
  inp.addEventListener('keydown', function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
  inp.addEventListener('input', ar);
  btnR.addEventListener('click', function() { authFetch('/api/reset', { method: 'POST' }); ws.send(JSON.stringify({ type: 'reset' })); });

  conn();
})();
</script>
</body>
</html>`;
}
