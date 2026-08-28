import { useEffect, useState } from 'react';
import { LOCALES, type Locale } from '../i18n';
import type { PermissionLevel, Settings as S } from '../lib/settings';

type T = (key: string) => string;
type Tab = 'general' | 'agent' | 'skills' | 'about';

interface SkillInfo { id: string; name: string; description?: string; source?: string }

export function SettingsPanel({
  settings, tools, t, onChange, onClose,
}: {
  settings: S;
  tools: string[];
  t: T;
  onChange: (patch: Partial<S>) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('general');
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [plugins, setPlugins] = useState<SkillInfo[] | null>(null);

  // Skills and plugins are engine-side facts, so they are fetched rather than
  // guessed. A failure leaves the list null and the UI says "none found"
  // rather than pretending an empty set is a confirmed empty set.
  const loadExtensions = () => {
    setSkills(null);
    setPlugins(null);
    void fetch('./api/skills').then((r) => (r.ok ? r.json() : null))
      .then((d) => setSkills(Array.isArray(d?.skills) ? d.skills : []))
      .catch(() => setSkills([]));
    void fetch('./api/plugins').then((r) => (r.ok ? r.json() : null))
      .then((d) => setPlugins(Array.isArray(d?.plugins) ? d.plugins : []))
      .catch(() => setPlugins([]));
  };
  useEffect(() => { if (tab === 'skills') loadExtensions(); }, [tab]);

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
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('settings.close')}>✕</button>
        </header>

        <nav className="tabs">
          {(['general', 'agent', 'skills', 'about'] as Tab[]).map((id) => (
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

          {tab === 'agent' && (
            <>
              <Field label={t('settings.model')}>
                <input
                  className="input"
                  value={settings.model}
                  placeholder="anthropic/claude-sonnet-5"
                  onChange={(e) => onChange({ model: e.target.value })}
                />
              </Field>
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
              <Field label="Tools">
                <div className="chips">
                  {tools.length === 0
                    ? <span className="field-hint">—</span>
                    : tools.map((name) => <span key={name} className="chip">{name}</span>)}
                </div>
              </Field>
            </>
          )}

          {tab === 'skills' && (
            <>
              <div className="row-between">
                <span className="field-label">{t('settings.skills')}</span>
                <button type="button" className="btn btn-ghost" onClick={loadExtensions}>
                  ⟳ {t('settings.reload')}
                </button>
              </div>

              <div className="ext-list">
                {skills === null ? (
                  <div className="field-hint">…</div>
                ) : skills.length === 0 ? (
                  <div className="field-hint">{t('settings.skillsNone')}</div>
                ) : (
                  skills.map((s) => {
                    const off = settings.disabledSkills.includes(s.id);
                    return (
                      <label key={s.id} className="ext">
                        <input
                          type="checkbox"
                          checked={!off}
                          onChange={() => onChange({
                            disabledSkills: off
                              ? settings.disabledSkills.filter((x) => x !== s.id)
                              : [...settings.disabledSkills, s.id],
                          })}
                        />
                        <span className="ext-body">
                          <span className="ext-name">{s.name || s.id}</span>
                          {s.description && <span className="ext-desc">{s.description}</span>}
                        </span>
                      </label>
                    );
                  })
                )}
              </div>

              <div className="row-between" style={{ marginTop: 18 }}>
                <span className="field-label">Plugins</span>
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
                        <span className="ext-name">{p.name || p.id}</span>
                        {p.description && <span className="ext-desc">{p.description}</span>}
                      </span>
                    </div>
                  ))
                )}
              </div>
              {/* Plugins run unsandboxed with full privileges — see src/plugins/hooks.ts. */}
              <p className="field-hint warn-hint">
                Plugins are user-installed code and run with your full privileges. Install only what you trust.
              </p>
            </>
          )}

          {tab === 'about' && (
            <div className="about">
              <p className="about-line">Aura — model-agnostic autonomous coding agent.</p>
              <p className="field-hint">
                This client speaks the same protocol as <code>aura sidecar</code>, over the
                WebSocket that served the page.
              </p>
            </div>
          )}
        </div>
      </div>
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
