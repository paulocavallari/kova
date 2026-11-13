import { useEffect, useMemo, useState } from 'react';
import { PiArrowLeftBold } from 'react-icons/pi';
import { useT } from '../i18n';
import { ask, cancelChat, newConversation, useChatSession } from '../lib/ai-chat';
import { getAiKey, isConfigured } from '../lib/ai-config';
import { buildSnapshot, snapshotStats, TX_CAP } from '../lib/ai-context';
import { today } from '../lib/calc';
import { openOverlay } from '../lib/nav';
import { useStore } from '../lib/store';
import { AiSettingsSheet } from '../components/AiUI';
import { Empty } from '../components/ui';

function hostOf(raw?: string): string {
  if (!raw) return '';
  try {
    return new URL(raw).host;
  } catch {
    return '';
  }
}

export function Chat() {
  const { t } = useT();
  const st = useStore();
  const chat = useChatSession();
  const [hasKey, setHasKey] = useState(false);
  const [draft, setDraft] = useState('');

  const refreshKey = () => {
    void getAiKey().then((k) => setHasKey(Boolean(k)));
  };

  useEffect(() => {
    refreshKey();
  }, [st.settings.ai?.baseUrl, st.settings.ai?.model]);

  const configured = isConfigured(st.settings.ai, hasKey);
  const host = hostOf(st.settings.ai?.baseUrl);

  const approxK = useMemo(() => {
    if (!configured) return '1';
    const stats = snapshotStats(buildSnapshot(st, today(), { txCap: chat.txCap }));
    return String(Math.max(1, Math.round(stats.approxTokens / 1000)));
  }, [configured, st, chat.txCap]);

  const send = () => {
    const q = draft.trim();
    if (!q || chat.pending) return;
    setDraft('');
    void ask(q);
  };

  return (
    <div className="screen chat-wrap">
      <div className="topbar">
        <button className="icon-btn" onClick={() => history.back()} aria-label="back">
          <PiArrowLeftBold />
        </button>
        <h1>{t('chatTitle')}</h1>
        {configured && (
          <button type="button" className="btn ghost" onClick={newConversation} disabled={chat.pending && chat.messages.length === 0}>
            {t('chatNew')}
          </button>
        )}
      </div>

      {!configured ? (
        <div className="chat-empty">
          <Empty title={t('chatNeedConfig')} hint={t('chatNeedConfigD')} />
          <button
            type="button"
            className="btn primary"
            onClick={() => openOverlay((close) => <AiSettingsSheet onDone={() => { close(); refreshKey(); }} />)}
          >
            {t('chatConfigure')}
          </button>
        </div>
      ) : (
        <>
          <div className="chat-info">
            <div>{t('chatDataBanner', { h: host, k: approxK })}</div>
            {chat.noTools && <div className="muted">{t('chatNoToolsNote')}</div>}
            {chat.txCap < TX_CAP && <div className="muted">{t('chatCapNote')}</div>}
            {chat.droppedEffort && <div className="muted">{t('chatEffortNote')}</div>}
          </div>

          <div className="chat-list">
            {chat.messages.length === 0 && !chat.pending && (
              <div className="chat-sugs">
                {[t('chatSug1'), t('chatSug2')].map((sug) => (
                  <button key={sug} type="button" className="btn ghost" onClick={() => void ask(sug)}>
                    {sug}
                  </button>
                ))}
              </div>
            )}

            {chat.messages.map((m) => (
              <div key={m.id} className={'chat-msg ' + m.role}>
                {m.text}
              </div>
            ))}

            {chat.pending && <div className="chat-msg assistant muted">{t('chatThinking')}</div>}
          </div>

          <form
            className="chat-bar"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t('chatPlaceholder')}
              disabled={chat.pending}
            />
            {chat.pending && (
              <button type="button" className="btn ghost" onClick={cancelChat}>
                {t('chatCancel')}
              </button>
            )}
            <button type="submit" className="btn primary" disabled={chat.pending || !draft.trim()}>
              {t('chatSend')}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
