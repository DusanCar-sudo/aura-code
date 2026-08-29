import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';
import { LOCALES, type Locale } from '../i18n';
import type { PermissionLevel, Settings as S } from '../lib/settings';

type T = (key: string) => string;
type Tab = 'general' | 'provider' | 'skills' | 'about';

interface ProviderModel { id: string; label: string; speed: string; contextWindow: number }
interface ProviderInfo {
  name: string;
  baseUrl: string;
  envKey: string | null;
  signupUrl: string;
  /** Whether a key is configured. Never the key itself. */
  keySet: boolean;
  models: ProviderModel[];
}
interface SkillInfo {
  id: string; name: string; description?: string; source?: string;
}
interface PluginInfo {
  id: string; name: string; description?: string;
  commands?: number; skills?: number; hooks?: number;
}

export interface ToolInfo { name: string; description: string }

export function SettingsPanel({
  settings, tools, t, initialTab = 'general', onChange, onClose,
}: {
  settings: S;
  tools: ToolInfo[];
  t: T;
  /** Which tab to land on — `:provider` and `:apikey` open straight to it. */
  initialTab?: Tab;
  onChange: (patch: Partial<S>) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);

  const permissions: Array<{ value: PermissionLevel; label: string; hint: string }> = [
    { value: 'read-only', label: t('settings.permissionReadOnly'), hint: t('settings.permissionReadOnlyHint') },
    { value: 'normal', label: t('settings.permissionNormal'), hint: t('settings.permissionNormalHint') },
    { value: 'auto', label: t('settings.permissionAuto'), hint: t('settings.permissionAutoHint') },
  ];

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 className="modal-title">{t('settings.title')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('settings.close')}><Icon name="close" /></button>
        </header>

        <nav className="tabs">
          {(['general', 'provider', 'skills', 'about'] as Tab[]).map((id) => (
            <button
              key={id}
              type="button"
              className={`tab ${tab === id ? 'tab-active' : ''}`}
              onClick={() => setTab(id)}
            >
              {t(`settings.${id}`)}
            </button>
          ))}
        </nav>

        <div className="modal-body">
          {tab === 'general' && (
            <>
              <Field label={t('settings.language')}>
                <select
                  className="select"
                  value={settings.locale}
                  onChange={(e) => onChange({ locale: e.target.value as Locale })}
                >
                  {(Object.keys(LOCALES) as Locale[]).map((code) => (
                    <option key={code} value={code}>
                      {LOCALES[code].native} — {LOCALES[code].name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label={t('settings.theme')}>
                <div className="segmented">
                  {(['dark', 'light'] as const).map((th) => (
                    <button
                      key={th}
                      type="button"
                      className={`seg ${settings.theme === th ? 'seg-on' : ''}`}
                      onClick={() => onChange({ theme: th })}
                    >
                      {t(th === 'dark' ? 'settings.themeDark' : 'settings.themeLight')}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label={t('settings.permission')}>
                <div className="radios">
                  {permissions.map((p) => (
                    <label key={p.value} className={`radio ${settings.permission === p.value ? 'radio-on' : ''}`}>
                      <input
                        type="radio"
                        name="permission"
                        checked={settings.permission === p.value}
                        onChange={() => onChange({ permission: p.value })}
                      />
                      <span className="radio-label">{p.label}</span>
                      <span className="radio-hint">{p.hint}</span>
                    </label>
                  ))}
                </div>
              </Field>

              <Field label={t('settings.sandbox')}>
                <div className="segmented">
                  <button type="button" className="seg seg-on" disabled>
                    {t('settings.sandboxOff')}
                  </button>
                  <button type="button" className="seg" disabled>
                    {t('settings.sandboxOn')}
                  </button>
                </div>
                {/* The honest disclosure from SECURITY.md, not a marketing line.
                    The control is disabled because --sandboxed is designed but
                    not implemented (docs/SANDBOX-DESIGN.md). Shipping a live
                    toggle that changes nothing would manufacture exactly the
                    false confidence that document exists to remove. */}
                <p className="field-hint">{t('settings.sandboxHint')}</p>
                <p className="field-hint warn-hint">{t('settings.sandboxPending')}</p>
              </Field>
            </>
          )}

          {tab === 'provider' && (
            <ProviderTab settings={settings} tools={tools} t={t} onChange={onChange} />
          )}

          {tab === 'skills' && <SkillsTab t={t} />}

          {tab === 'about' && <AboutTab t={t} />}
        </div>
      </div>
    </div>
  );
}

/**
 * Provider / Agent.
 *
 * The provider is named explicitly and picked from the engine's own registry,
 * rather than left as a free-text model id the operator has to know by heart.
 * When the provider's key is not configured, the field to paste one appears
 * right there — a model list you cannot actually call is a dead end.
 */
function ProviderTab({
  settings, tools, t, onChange,
}: {
  settings: S; tools: ToolInfo[]; t: T; onChange: (patch: Partial<S>) => void;
}) {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  // Whether this bind will accept a key at all. Offering an input that answers
  // every save with a 403 is worse than saying so up front.
  const [keysWritable, setKeysWritable] = useState(true);
  // The env key of the model the server is actually running, so the panel can
  // show the provider in use rather than nothing at all.
  const [activeEnvKey, setActiveEnvKey] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyNote, setKeyNote] = useState<string | null>(null);

  const load = useCallback(() => {
    void fetch('./api/providers')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setProviders(Array.isArray(d?.providers) ? d.providers : []);
        if (d && typeof d.apiKeysWritable === 'boolean') setKeysWritable(d.apiKeysWritable);
        setActiveEnvKey(typeof d?.activeEnvKey === 'string' ? d.activeEnvKey : null);
      })
      .catch(() => setProviders([]));
  }, []);
  useEffect(load, [load]);

  const current = providers?.find((p) => p.name === settings.provider)
    // Fall back to whichever provider owns the configured model, so an existing
    // setup shows the right provider instead of an empty box.
    ?? providers?.find((p) => p.models.some((m) => settings.model.endsWith(m.id)))
    // Last: the provider the *server* is running. Suffix matching cannot see
    // a routed id like `fpt/Z.ai:GLM-5.3`, which left a working setup showing
    // no provider — and with no provider, no model picker and no API-key
    // field, which reads as "the settings panel is empty".
    ?? (activeEnvKey ? providers?.find((p) => p.envKey === activeEnvKey) : undefined);

  const saveKey = async () => {
    if (!current?.envKey || !keyDraft.trim()) return;
    setKeyBusy(true);
    setKeyNote(null);
    try {
      const res = await fetch('./api/apikey', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envKey: current.envKey, value: keyDraft.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setKeyDraft('');
      setKeyNote(t('settings.keySaved'));
      load();
    } catch (e) {
      setKeyNote(String(e instanceof Error ? e.message : e));
    } finally {
      setKeyBusy(false);
    }
  };

  return (
    <>
      <Field label={t('settings.provider')}>
        <select
          className="select"
          value={current?.name ?? ''}
          onChange={(e) => {
            const next = providers?.find((p) => p.name === e.target.value);
            onChange({
              provider: e.target.value,
              // Move to that provider's first model, so the pair is never
              // mismatched — a provider with another vendor's model id is a 404.
              model: next?.models[0]?.id ?? '',
            });
            setKeyDraft('');
            setKeyNote(null);
          }}
        >
          <option value="" disabled>{t('settings.providerPick')}</option>
          {(providers ?? []).map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}{p.envKey && !p.keySet ? ` — ${t('settings.keyMissingShort')}` : ''}
            </option>
          ))}
        </select>
      </Field>

      {current && (
        <>
          <Field label={t('settings.model')}>
            <select
              className="select"
              value={settings.model}
              onChange={(e) => onChange({ model: e.target.value })}
            >
              <option value="">{t('settings.modelDefault')}</option>
              {current.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · {m.speed} · {Math.round(m.contextWindow / 1000)}k
                </option>
              ))}
            </select>
            <p className="field-hint">{current.baseUrl}</p>
          </Field>

          <Field label={t('settings.apiKey')}>
            {current.envKey === null ? (
              <p className="field-hint">{t('settings.keyNotNeeded')}</p>
            ) : !keysWritable && !current.keySet ? (
              <p className="field-hint">{t('settings.keyLocked')}</p>
            ) : current.keySet ? (
              <div className="key-row">
                <span className="key-ok"><Icon name="check" /> {t('settings.keySet')} <code>{current.envKey}</code></span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setKeyDraft('');
                    void fetch('./api/apikey', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ envKey: current.envKey, value: '' }),
                    }).then(load);
                  }}
                >
                  {t('settings.keyClear')}
                </button>
              </div>
            ) : (
              <>
                <div className="key-row">
                  <input
                    className="input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={keyDraft}
                    placeholder={current.envKey}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(); }}
                  />
                  <button
                    type="button"
                    className="btn btn-send"
                    disabled={!keyDraft.trim() || keyBusy}
                    onClick={() => void saveKey()}
                  >
                    {t('settings.save')}
                  </button>
                </div>
                {/* Says plainly where the secret goes, because a paste field
                    that is vague about that is a field people should not use. */}
                <p className="field-hint">{t('settings.keyScope')}</p>
                <a className="field-link" href={current.signupUrl} target="_blank" rel="noreferrer noopener">
                  {t('settings.keyGet')} ↗
                </a>
              </>
            )}
            {keyNote && <p className="field-hint warn-hint">{keyNote}</p>}
          </Field>
        </>
      )}

      <Field label={t('settings.maxTurns')}>
        <input
          className="input"
          type="number"
          min={1}
          value={settings.maxTurns}
          onChange={(e) => onChange({ maxTurns: Number(e.target.value) || 1 })}
        />
      </Field>

      <Field label={t('settings.budget')}>
        <input
          className="input"
          type="number"
          min={0}
          value={settings.maxInputTokens}
          onChange={(e) => onChange({ maxInputTokens: Number(e.target.value) || 0 })}
        />
      </Field>

      <Field label={t('settings.tools')}>
        {tools.length === 0 ? (
          <span className="field-hint">—</span>
        ) : (
          <>
            <div className="row-between tool-bulk">
              <span className="field-hint">
                {tools.length - settings.disabledTools.length}/{tools.length} {t('settings.toolsOn')}
              </span>
              <span className="tool-bulk-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => onChange({ disabledTools: [] })}
                >
                  {t('settings.toolsAll')}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => onChange({ disabledTools: tools.map((x) => x.name) })}
                >
                  {t('settings.toolsNone')}
                </button>
              </span>
            </div>
            <div className="chips">
              {tools.map((tool) => {
                const off = settings.disabledTools.includes(tool.name);
                return (
                  <button
                    key={tool.name}
                    type="button"
                    className={`chip chip-toggle ${off ? '' : 'chip-on'}`}
                    title={tool.description || tool.name}
                    aria-pressed={!off}
                    onClick={() => onChange({
                      disabledTools: off
                        ? settings.disabledTools.filter((n) => n !== tool.name)
                        : [...settings.disabledTools, tool.name],
                    })}
                  >
                    {tool.name}
                  </button>
                );
              })}
            </div>
            {/* Says exactly what this does and does not do, so it is not read
                as a security control — blocking execution is the permission
                level's job, not this list's. */}
            <p className="field-hint">{t('settings.toolsHint')}</p>
          </>
        )}
      </Field>
    </>
  );
}

/**
 * Skills & plugins.
 *
 * Source-agnostic by construction: the engine's installer already takes a
 * marketplace name, an owner/repo, a git URL, or a local path, so a Claude
 * plugin, a DeepSeek plugin, or a private repo all install the same way. Skills
 * arrive inside plugins, which is why removing a skill removes its plugin and
 * the UI says which plugin that is.
 */
function SkillsTab({ t }: { t: T }) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [spec, setSpec] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(() => {
    setSkills(null);
    setPlugins(null);
    void fetch('./api/skills').then((r) => (r.ok ? r.json() : null))
      .then((d) => setSkills(Array.isArray(d?.skills) ? d.skills : []))
      .catch(() => setSkills([]));
    void fetch('./api/plugins').then((r) => (r.ok ? r.json() : null))
      .then((d) => setPlugins(Array.isArray(d?.plugins) ? d.plugins : []))
      .catch(() => setPlugins([]));
  }, []);
  useEffect(load, [load]);

  const install = async () => {
    const value = spec.trim();
    if (!value) {
      // Previously the button was simply disabled, which reads as broken
      // rather than as "type something first".
      setNote({ kind: 'err', text: t('settings.addEmpty') });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch('./api/plugins/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: value }),
      });
      const data = await res.json().catch(() => null);
      // 403 means the server was started without --allow-plugin-install. Its
      // message names the flag, so pass it through rather than paraphrasing.
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setSpec('');
      setNote({
        kind: 'ok',
        text: [t('settings.installed'), ...(data?.warnings ?? [])].join(' · '),
      });
      load();
    } catch (e) {
      setNote({ kind: 'err', text: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    if (!confirm(t('settings.removeConfirm'))) return;
    await fetch('./api/plugins/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    load();
  };

  return (
    <>
      <Field label={t('settings.addPlugin')}>
        <div className="key-row">
          <input
            className="input"
            value={spec}
            placeholder="owner/repo · name@marketplace · git URL · /local/path"
            onChange={(e) => setSpec(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void install(); }}
          />
          <button
            type="button"
            className="btn btn-send"
            disabled={busy}
            onClick={() => void install()}
          >
            {busy ? '…' : t('settings.add')}
          </button>
        </div>
        <p className="field-hint">{t('settings.addPluginHint')}</p>
        {/* The engine's own error, verbatim — "no marketplaces registered" and
            "directory contains no plugin" both tell you exactly what to fix. */}
        {note && (
          <p className={`install-note ${note.kind === 'err' ? 'install-err' : 'install-ok'}`}>
            {note.text}
          </p>
        )}
      </Field>

      <div className="row-between">
        <span className="field-label">{t('settings.installedPlugins')}</span>
        <button type="button" className="btn btn-ghost" onClick={load}>⟳ {t('settings.reload')}</button>
      </div>
      <div className="ext-list">
        {plugins === null ? (
          <div className="field-hint">…</div>
        ) : plugins.length === 0 ? (
          <div className="field-hint">{t('settings.pluginsNone')}</div>
        ) : (
          plugins.map((p) => (
            <div key={p.id} className="ext">
              <span className="ext-body">
                <span className="ext-name">{p.name}</span>
                {p.description && <span className="ext-desc">{p.description}</span>}
                <span className="ext-desc">
                  {p.skills ?? 0} skills · {p.commands ?? 0} commands · {p.hooks ?? 0} hooks
                </span>
              </span>
              <button type="button" className="ext-del" onClick={() => void remove(p.id)}>
                {t('settings.remove')}
              </button>
            </div>
          ))
        )}
      </div>

      <div className="row-between" style={{ marginTop: 18 }}>
        <span className="field-label">{t('settings.skills')}</span>
      </div>
      <div className="ext-list">
        {skills === null ? (
          <div className="field-hint">…</div>
        ) : skills.length === 0 ? (
          <div className="field-hint">{t('settings.skillsNone')}</div>
        ) : (
          skills.map((s) => (
            <div key={s.id} className="ext">
              <span className="ext-body">
                <span className="ext-name">{s.name}</span>
                {s.description && <span className="ext-desc">{s.description}</span>}
                <span className="ext-desc">{t('settings.fromPlugin')} {s.source}</span>
              </span>
              {s.source && (
                <button type="button" className="ext-del" onClick={() => void remove(s.source!)}>
                  {t('settings.remove')}
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {/* Plugins run unsandboxed with full privileges — src/plugins/hooks.ts. */}
      <p className="field-hint warn-hint">{t('settings.pluginWarning')}</p>
    </>
  );
}

function AboutTab({ t }: { t: T }) {
  return (
    <div className="about">
      <div className="about-head">
        <span className="about-mark">Lean Progress IQ</span>
        <span className="about-sub">{t('settings.aboutTagline')}</span>
      </div>

      <Field label={t('settings.creator')}>
        <p className="about-line">Dušan Milosavljević</p>
      </Field>

      <Field label={t('settings.links')}>
        <div className="about-links">
          <a className="field-link" href="https://leanproiq.com" target="_blank" rel="noreferrer noopener">
            leanproiq.com ↗
          </a>
          <a
            className="field-link"
            href="https://github.com/leanprogressiq"
            target="_blank"
            rel="noreferrer noopener"
          >
            GitHub ↗
          </a>
        </div>
      </Field>

      <Field label={t('settings.ecosystem')}>
        <div className="eco">
          <div className="eco-item">
            <span className="eco-name">Aura Code</span>
            <span className="eco-desc">{t('settings.ecoCode')}</span>
          </div>
          <div className="eco-item">
            <span className="eco-name">Aura Droid</span>
            <span className="eco-desc">{t('settings.ecoDroid')}</span>
          </div>
          <div className="eco-item">
            <span className="eco-name">Mesh</span>
            <span className="eco-desc">{t('settings.ecoMesh')}</span>
          </div>
          <div className="eco-item">
            <span className="eco-name">Archimedes</span>
            <span className="eco-desc">{t('settings.ecoArchimedes')}</span>
          </div>
        </div>
      </Field>

      <p className="field-hint">{t('settings.aboutProtocol')}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {children}
    </div>
  );
}
