import { useSyncExternalStore } from 'react';
import { getT } from '../i18n';
import { getAiKey, isConfigured } from './ai-config';
import { AiError, chat, type ChatMessage, type ChatResult, type ClientOpts } from './ai-client';
import { runTool, systemPrompt, TOOLS, TX_CAP, TX_CAP_SMALL } from './ai-context';
import { today, uid } from './calc';
import { getState } from './store';

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
}

export interface ChatSessionState {
  messages: ChatEntry[];
  pending: boolean;
  error: string;
  noTools: boolean;
  droppedEffort: boolean;
  txCap: number;
}

const INITIAL: ChatSessionState = {
  messages: [],
  pending: false,
  error: '',
  noTools: false,
  droppedEffort: false,
  txCap: TX_CAP,
};

let session: ChatSessionState = { ...INITIAL };
let gen = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const l of listeners) l();
};

const setSession = (patch: Partial<ChatSessionState>) => {
  session = { ...session, ...patch };
  emit();
};

export function useChatSession(): ChatSessionState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => session,
  );
}

export function getChatSession(): ChatSessionState {
  return session;
}

export function cancelChat(): void {
  gen++;
  if (session.pending) setSession({ pending: false });
}

export function newConversation(): void {
  gen++;
  setSession({ messages: [], pending: false, error: '' });
}

export function resetChatSession(): void {
  gen++;
  session = { ...INITIAL };
  emit();
}

export function aiErrorLabel(t: (key: any) => string, err: unknown): string {
  if (err instanceof AiError) {
    const map: Record<string, string> = {
      auth: t('aiErrAuth'),
      network: t('aiErrNetwork'),
      redirect: t('aiErrNetwork'),
      model: t('aiErrModel'),
      rate: t('aiErrRate'),
      server: t('aiErrServer'),
      context: t('aiErrContext'),
      length: t('aiErrLength'),
      format: t('aiErrFormat'),
    };
    return map[err.code] ?? (err.message || t('aiErrFormat'));
  }
  return t('aiErrFormat');
}

export function formatAiError(err: unknown): string {
  return aiErrorLabel(getT(), err);
}

/** Sends one user prompt with D14-frozen snapshot/state and up to 3 tool rounds (max 4 normal / 6 hard HTTP cap). */
export async function ask(text: string, opts: ClientOpts & { day?: string } = {}): Promise<void> {
  const clean = text.trim();
  if (!clean || session.pending) return;

  const myGen = gen;
  const frozenState = getState();
  const cfg = frozenState.settings.ai;
  const key = await getAiKey().catch(() => undefined);
  if (myGen !== gen) return;

  if (!cfg || !isConfigured(cfg, key)) {
    const msg = getT()('aiErrKeyMissing');
    setSession({ error: msg, messages: [...session.messages, { id: uid(), role: 'error', text: msg }] });
    return;
  }

  const day = opts.day ?? today();
  const prior = session.messages
    .filter((m): m is ChatEntry & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.text } satisfies ChatMessage));

  let activeCap = session.txCap;
  let sys = systemPrompt(frozenState, frozenState.settings.lang, day, { txCap: activeCap });
  const tools = session.noTools ? undefined : TOOLS;
  let activeEffort = session.droppedEffort ? 'auto' : cfg.effort;
  const thread: ChatMessage[] = [{ role: 'system', content: sys }, ...prior, { role: 'user', content: clean }];

  setSession({
    pending: true,
    error: '',
    messages: [...session.messages, { id: uid(), role: 'user', text: clean }],
  });

  let didContextRetry = false;
  let httpCount = 0;

  try {
    for (let round = 0; round < 4;) {
      if (httpCount >= 6) throw new AiError('format', 'Request limit reached');

      let res: ChatResult;
      try {
        res = await chat(cfg, key ?? '', { messages: thread, tools: session.noTools ? undefined : tools, effort: activeEffort }, opts);
      } catch (e) {
        if (myGen !== gen) return;
        if (e instanceof AiError && e.code === 'context' && !didContextRetry && activeCap > TX_CAP_SMALL) {
          didContextRetry = true;
          httpCount += e.requests ?? 1;
          if (e.droppedEffort) {
            activeEffort = 'auto';
            if (!session.droppedEffort) setSession({ droppedEffort: true });
          }
          if (e.droppedTools && !session.noTools) setSession({ noTools: true });
          activeCap = TX_CAP_SMALL;
          setSession({ txCap: TX_CAP_SMALL });
          sys = systemPrompt(frozenState, frozenState.settings.lang, day, { txCap: TX_CAP_SMALL });
          thread[0] = { role: 'system', content: sys };
          continue;
        }
        throw e;
      }

      if (myGen !== gen) return;
      httpCount += res.requests;
      if (res.droppedEffort) {
        activeEffort = 'auto';
        if (!session.droppedEffort) setSession({ droppedEffort: true });
      }
      if (res.droppedTools && !session.noTools) setSession({ noTools: true });

      if (res.toolCalls.length === 0) {
        setSession({
          pending: false,
          messages: [...session.messages, { id: uid(), role: 'assistant', text: res.content }],
        });
        return;
      }

      if (round === 3) throw new AiError('format', 'Tool call limit reached');

      thread.push({
        role: 'assistant',
        content: res.content || null,
        tool_calls: res.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
      for (const tc of res.toolCalls) {
        const result = runTool(tc.name, tc.arguments, frozenState, day);
        thread.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      round++;
    }
  } catch (e) {
    if (myGen !== gen) return;
    const msg = formatAiError(e);
    setSession({
      pending: false,
      error: msg,
      messages: [...session.messages, { id: uid(), role: 'error', text: msg }],
    });
  }
}
