import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// RTK (Rust Token Killer) command wrapping.
//
// Aura's shell and git tools shell out through Node's exec/execSync, which the
// RTK shell hook never sees — it only rewrites commands typed at a terminal. So
// raw `git diff`/`git log`/`grep` output reached the context window
// uncompressed, and the bloat compounded across a session (measured: 1.28M
// input tokens over three tasks, versus 253K once every call site was proxied).
//
// Prefixing `rtk` unconditionally would make it a hard runtime dependency of a
// published npm package: every `run_shell` call on a machine without it would
// come back "rtk: command not found". So availability is probed once, from PATH,
// and the bare command is used when it isn't there.
//
// `rtk` proxies exactly one *simple command*: it exec()s its argv directly and
// has no shell of its own. Prefixing it onto a shell *string* is therefore a
// category error, and it broke every command whose head was not a real binary.
// `cd X && cmd` became `rtk cd X && cmd`, which the outer sh parses as
// `rtk cd X` && `cmd` — rtk is handed argv ["cd","X"], there is no /usr/bin/cd,
// and the exec fails with "[rtk: No such file or directory (os error 2)]", after
// which && short-circuits and `cmd` never runs. Every builtin and keyword
// failed the same way (export, source, eval, set, umask, read), as did
// assignment prefixes (`FOO=1 cmd`); anything *starting* with a compound
// construct failed harder still, as a shell syntax error — `rtk (cd /tmp && pwd)`.
//
// The `;` form looked like a workaround but was the most dangerous case: the cd
// was swallowed identically, `;` does not short-circuit, so the rest of the line
// ran in the *original* directory and the last command's exit status made it
// look clean.
//
// So the string is scanned rather than prefixed, and `rtk ` is inserted only in
// front of those top-level segments whose head word is a tool RTK actually has a
// filter for. Builtins, keywords, subshells, operators, redirects and quoted
// text are copied through byte for byte.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tools RTK has an output filter for, keyed by the command head it proxies.
 *
 * Only real binaries whose RTK subcommand means the *same thing* as the command
 * it stands in for. Three of RTK's subcommands collide with a shell command of
 * the same name and mean something different — `test` runs a test suite (the
 * shell's is a conditional), `read` reads a file (the shell's reads stdin),
 * `env` prints variables (the shell's runs a command) — so wrapping those would
 * turn working commands into nonsense. RTK's meta commands (`gain`, `run`,
 * `proxy`, `init`, `config`, …) and its cross-tool aggregators (`lint`,
 * `format`, `err`, `json`, `deps`, `log`, `smart`, `summary`) are not proxies
 * for a binary of that name and never appear as a command head.
 */
const PROXIES = new Set([
  'aws', 'cargo', 'curl', 'diff', 'docker', 'dotnet', 'find', 'gh', 'git',
  'glab', 'go', 'golangci-lint', 'gradlew', 'grep', 'gt', 'jest', 'kubectl',
  'ls', 'mvn', 'mypy', 'next', 'npm', 'npx', 'oc', 'pip', 'playwright',
  'pnpm', 'prettier', 'prisma', 'psql', 'pytest', 'rake', 'rg', 'rspec',
  'rubocop', 'ruff', 'tree', 'tsc', 'vitest', 'wc', 'wget',
]);

/** Half-open `[start, end)` slice of the original command string. */
interface Segment { start: number; end: number; }

/**
 * The command's top-level segments — the pieces the shell will run as separate
 * simple commands — or null when the string contains something this scanner
 * will not risk rewriting.
 *
 * Quoted runs and `$(…)`/`(…)`/`{…}` nesting are opaque, so `echo "a && b"` is
 * one segment and the `;` in `{ cd /tmp; pwd; }` is not a separator. Redirects
 * are deliberately *not* separators: the shell applies them around whatever it
 * runs, so `git diff > out.txt` stays one segment and rtk still receives a clean
 * argv.
 */
function segments(command: string): Segment[] | null {
  const out: Segment[] = [];
  const n = command.length;
  let start = 0;
  let depth = 0;
  let i = 0;

  while (i < n) {
    const c = command[i];

    if (c === '\\') { i += 2; continue; }

    if (c === "'") {
      // No escapes inside single quotes — the next quote always closes.
      const close = command.indexOf("'", i + 1);
      i = close === -1 ? n : close + 1;
      continue;
    }
    if (c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < n && command[i] !== quote) i += command[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }

    // A heredoc body is arbitrary text that can contain lines which look like
    // commands, and the delimiter can be anything. Refuse the whole string
    // rather than risk rewriting someone's file content.
    if (c === '<' && command[i + 1] === '<') return null;

    if (c === '$' && command[i + 1] === '(') { depth += 1; i += 2; continue; }
    if (c === '(' || c === '{') { depth += 1; i += 1; continue; }
    if (c === ')' || c === '}') { depth = Math.max(0, depth - 1); i += 1; continue; }

    if (depth === 0) {
      const two = command.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === ';;' || two === '|&') {
        out.push({ start, end: i });
        i += 2;
        start = i;
        continue;
      }
      // The `&` in `2>&1` or `>&2` belongs to the redirect, not to the shell's
      // background operator.
      const inRedirect = c === '&' && (command[i - 1] === '>' || command[i - 1] === '<');
      if (!inRedirect && (c === '|' || c === ';' || c === '&' || c === '\n')) {
        out.push({ start, end: i });
        i += 1;
        start = i;
        continue;
      }
    }
    i += 1;
  }

  out.push({ start, end: n });
  return out;
}

/**
 * Offset at which `rtk ` should be inserted for this segment, or null when the
 * segment must be left alone.
 */
function insertionPoint(command: string, seg: Segment): number | null {
  const blank = (j: number) => j < seg.end && /\s/.test(command[j]);
  let i = seg.start;

  for (;;) {
    while (blank(i)) i += 1;
    if (i >= seg.end) return null;

    const head = i;
    while (i < seg.end && !/\s/.test(command[i])) i += 1;
    const token = command.slice(head, i);

    // `FOO=1 git diff` — assignment prefixes are transparent to exec, so they
    // stay out front and rtk goes in after them.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;

    return PROXIES.has(token) ? head : null;
  }
}

/** Memoized probe result. null = not looked yet. */
let available: boolean | null = null;

/** Look for an executable `rtk` on PATH. Deliberately a filesystem scan rather
 *  than spawning `which`/`where`: no child process, and no dependency on which
 *  lookup tool the host happens to have. */
function probePath(): boolean {
  const raw = process.env.PATH ?? '';
  if (!raw) return false;
  // On Windows the extension is what makes a file executable, and accessSync's
  // X_OK is not meaningful there — check the PATHEXT candidates by name instead.
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, `rtk${ext}`), fs.constants.X_OK);
        return true;
      } catch { /* keep looking */ }
    }
  }
  return false;
}

/**
 * Is the RTK proxy usable for this process?
 *
 * `AURA_RTK=0` forces it off (raw commands, e.g. when debugging what a tool
 * actually ran); `AURA_RTK=1` forces it on without probing. Otherwise PATH
 * decides, once per process — a tool that runs on every shell call cannot
 * afford to re-scan PATH each time.
 */
export function rtkAvailable(): boolean {
  const override = process.env.AURA_RTK;
  if (override === '0' || override === 'false') return false;
  if (override === '1' || override === 'true') return true;
  if (available === null) available = probePath();
  return available;
}

/** Forget the probe result. Tests only — PATH does not change under a session. */
export function resetRtkProbe(): void {
  available = null;
}

/**
 * `command` with RTK routed in front of the parts it can filter, when it is
 * installed; unchanged when it isn't.
 *
 * Shell semantics are preserved: only the head of a top-level simple command is
 * ever touched, so operators, redirects, subshells, builtins and quoting behave
 * exactly as they would without RTK. Already-prefixed commands are left alone
 * so wrapping stays idempotent.
 */
export function rtkWrap(command: string): string {
  if (!command) return command;
  if (/^\s*rtk\s/.test(command)) return command;
  if (!rtkAvailable()) return command;

  const segs = segments(command);
  if (!segs) return command;

  const points: number[] = [];
  for (const seg of segs) {
    const at = insertionPoint(command, seg);
    if (at !== null) points.push(at);
  }
  if (points.length === 0) return command;

  // Rebuilt from the original string so that every byte not deliberately
  // inserted survives untouched — spacing, quoting and operators included.
  let out = '';
  let cursor = 0;
  for (const at of points) {
    out += command.slice(cursor, at) + 'rtk ';
    cursor = at;
  }
  return out + command.slice(cursor);
}
