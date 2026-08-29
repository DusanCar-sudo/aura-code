import { useCallback, useEffect, useState } from 'react';
import { useAura } from './hooks/useAura';
import { loadSettings, saveSettings, type Settings } from './lib/settings';
import { LOCALES, translate } from './i18n';
import { Sidebar } from './components/Sidebar';
import { Chat } from './components/Chat';
import { SettingsPanel } from './components/Settings';
import { Board } from './components/Board';
import { SigilWatermark, Sigil } from './components/Sigil';
import { runCommand } from './lib/commands';

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 860);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'provider' | 'skills' | 'about'>('general');
  const [openMenuAt, setOpenMenuAt] = useState(0);
  // Which surface the main column is showing. Chat and Board are two views of
  // the same live session, not two places — switching keeps the turn running
  // and loses nothing, because the board is derived from the same messages.
  const [view, setView] = useState<'chat' | 'board'>('chat');

  const t = useCallback((key: string) => translate(settings.locale, key), [settings.locale]);

  const aura = useAura(settings);

  // Theme and direction are document-level facts, so they live on <html> where
  // CSS and the browser's own chrome can both see them.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.lang = settings.locale;
    root.dir = LOCALES[settings.locale].dir;
    saveSettings(settings);
  }, [settings]);

  const patch = useCallback((p: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...p }));
  }, []);

  /**
   * A leading ':' means a command, and a command must run or explain itself —
   * never reach the model. Sending `:resume` as a turn made the agent research
   * the word, which is the failure this intercept exists to prevent.
   */
  const submit = useCallback((text: string, attachments: Parameters<typeof aura.send>[1]) => {
    if (text.trim().startsWith(':')) {
      runCommand(text, {
        t,
        sessionId: aura.sessionId,
        conversations: aura.conversations,
        messages: aura.messages,
        usage: aura.usage,
        newChat: () => void aura.newChat(),
        openChat: (id) => void aura.openChat(id),
        note: aura.systemNote,
        openSettings: (tab) => { setSettingsTab(tab); setSettingsOpen(true); },
        openCommandMenu: () => setOpenMenuAt(Date.now()),
      });
      return;
    }
    void aura.send(text, attachments);
  }, [aura, t]);

  const usage = aura.usage;
  const totalTokens = usage ? usage.inputTokens + usage.outputTokens : 0;

  return (
    // `app-sidebar` tells the stylesheet the sidebar is docked, so the chat
    // column can be pulled back to the centre of the viewport rather than
    // sitting centred in the space left over beside it.
    <div className={`app ${sidebarOpen ? 'app-sidebar' : ''}`}>
      <SigilWatermark />

      <Sidebar
        conversations={aura.conversations}
        sessionId={aura.sessionId}
        open={sidebarOpen}
        t={t}
        onNew={() => { void aura.newChat(); setSidebarOpen(window.innerWidth > 860); }}
        onOpen={(id) => { void aura.openChat(id); if (window.innerWidth <= 860) setSidebarOpen(false); }}
        onDelete={(id) => void aura.deleteChat(id)}
        onSettings={() => setSettingsOpen(true)}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="main">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn menu-btn"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label={t('app.conversations')}
          >
            ☰
          </button>

          <div className="topbar-title">
            <Sigil size={18} />
            <span>{settings.model || 'Aura'}</span>
          </div>

          <div className="view-tabs" role="tablist" aria-label={t('view.board')}>
            {(['chat', 'board'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                className="view-tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
              >
                {t(`view.${v}`)}
              </button>
            ))}
          </div>

          <div className="topbar-right">
            {totalTokens > 0 && (
              <span className="meter" title={t('usage.tokens')}>
                {totalTokens.toLocaleString()} {t('usage.tokens')}
                {usage?.costUsd !== undefined && (
                  <span className="meter-cost"> · ${usage.costUsd.toFixed(4)}</span>
                )}
              </span>
            )}
            <span className={`status status-${aura.connection}`}>
              <span className="status-dot" aria-hidden="true" />
              <span className="status-text">
                {t(aura.connection === 'open' ? 'app.connected'
                  : aura.connection === 'connecting' ? 'app.connecting'
                  : 'app.disconnected')}
              </span>
            </span>
          </div>
        </header>

        {view === 'chat' ? (
          <Chat
            messages={aura.messages}
            busy={aura.busy}
            error={aura.error}
            t={t}
            openMenuAt={openMenuAt}
            onSend={submit}
            onStop={() => void aura.stop()}
            onRegenerate={() => void aura.regenerate()}
          />
        ) : (
          <Board
            board={aura.board}
            busy={aura.busy}
            onRun={(task) => void aura.runTask(task)}
            t={t}
          />
        )}
      </main>

      {aura.approval && (
        <div className="modal-scrim">
          <div className="modal modal-approval" role="alertdialog" aria-modal="true">
            <header className="modal-head">
              <h2 className="modal-title">{t('approval.title')}</h2>
            </header>
            <div className="modal-body">
              <div className="approval-tool">{aura.approval.tool}</div>
              <pre className="approval-detail">{aura.approval.detail}</pre>
            </div>
            <footer className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => aura.approval?.resolve(false)}>
                {t('approval.deny')}
              </button>
              <button type="button" className="btn btn-send" onClick={() => aura.approval?.resolve(true)}>
                {t('approval.allow')}
              </button>
            </footer>
          </div>
        </div>
      )}

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          tools={aura.tools}
          initialTab={settingsTab}
          t={t}
          onChange={patch}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
