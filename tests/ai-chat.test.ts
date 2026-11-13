import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/lib/defaults';
import { replaceState } from '../src/lib/store';
import { setAiKey, setAiKeyStorage } from '../src/lib/ai-config';
import { simulatePurchase } from '../src/lib/outlook';
import type { AiEffort, State } from '../src/lib/types';
import { ask, cancelChat, getChatSession, newConversation, resetChatSession } from '../src/lib/ai-chat';

const BASE_URL = 'https://api.example.test/v1';
const FAKE_KEY = 'TESTKEY-AAAA-0000';

function setupEnv(effort: AiEffort = 'auto', txCount = 2) {
  resetChatSession();
  const map = new Map<string, unknown>();
  setAiKeyStorage({ get: async (k) => map.get(k) as any, set: async (k, v) => { map.set(k, v); } });
  const s = initialState('pt');
  const txs = Array.from({ length: txCount }, (_, i) => ({
    id: `tx-${i}`, kind: 'expense' as const, accountId: 'bank', categoryId: 'bills',
    amount: 10_000, base: 10_000, date: '2026-11-05', note: `Despesa ${i}`, tags: [], created: '2026-11-05T00:00:00Z',
  }));
  txs.push({
    id: 'sal-1', kind: 'income' as any, accountId: 'bank', categoryId: 'salary',
    amount: 500_000, base: 500_000, date: '2026-11-05', note: 'Salário', tags: [], created: '2026-11-05T00:00:00Z',
    repeat: 'monthly', series: 'ser-sal',
  } as any);
  replaceState({ ...s, txs, settings: { ...s.settings, lang: 'pt', baseCurrency: 'BRL', ai: { baseUrl: BASE_URL, model: 'm-1', effort } } });
  return setAiKey(FAKE_KEY);
}

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('1: common question makes 1 request and appends assistant reply', async () => {
  await setupEnv();
  const bodies: any[] = [];
  await ask('Quanto gastei?', {
    day: '2026-11-12',
    fetchImpl: async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonRes({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Você gastou R$ 200,00.' } }] });
    },
  });
  assert.equal(bodies.length, 1);
  const ses = getChatSession();
  assert.equal(ses.pending, false);
  assert.equal(ses.error, '');
  assert.equal(ses.messages[0].role, 'user');
  assert.equal(ses.messages[1].text, 'Você gastou R$ 200,00.');
});

test('2 (D14): purchase tool loop executes simulatePurchase and keeps identical system/tools across rounds', async () => {
  await setupEnv();
  const bodies: any[] = [];
  let capturedSim: unknown;
  await ask('Posso comprar 3000 em 10x?', {
    day: '2026-11-12',
    fetchImpl: async (_u, init) => {
      const b = JSON.parse(String(init?.body));
      bodies.push(b);
      if (bodies.length === 1) {
        // Mutate state mid-question: D14 requires round 2 and runTool to keep initial frozen snapshot/state
        replaceState({ ...initialState('pt'), settings: { ...initialState('pt').settings, lang: 'pt', ai: { baseUrl: BASE_URL, model: 'm-1', effort: 'auto' } } });
        return jsonRes({
          choices: [{
            finish_reason: 'tool_calls',
            message: { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'simulate_purchase', arguments: JSON.stringify({ amount: 300_000, installments: 10 }) } }] },
          }],
        });
      }
      const toolMsg = b.messages.find((m: any) => m.role === 'tool');
      capturedSim = JSON.parse(toolMsg.content);
      return jsonRes({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Parcela de R$ 300,00.' } }] });
    },
  });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].messages[0].content, bodies[1].messages[0].content);
  assert.deepEqual(bodies[0].tools, bodies[1].tools);
  // Reset back to original fixture to compare simulatePurchase output
  await setupEnv();
  const expected = simulatePurchase((await import('../src/lib/store')).getState(), { amount: 300_000, installments: 10 }, '2026-11-12');
  assert.deepEqual(capturedSim, expected);
});

test('3: second question reflects state mutations in its system snapshot', async () => {
  await setupEnv();
  const systems: string[] = [];
  const fakeFetch = async (_u: any, init: any) => {
    systems.push(JSON.parse(String(init?.body)).messages[0].content);
    return jsonRes({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Ok' } }] });
  };
  await ask('Pergunta 1', { day: '2026-11-12', fetchImpl: fakeFetch });
  const cur = (await import('../src/lib/store')).getState();
  replaceState({ ...cur, txs: [...cur.txs, { id: 'new-tx', kind: 'expense', accountId: 'bank', categoryId: 'bills', amount: 77_700, base: 77_700, date: '2026-11-12', note: 'Compra Nova X', tags: [], created: '2026-11-12T00:00:00Z' }] });
  await ask('Pergunta 2', { day: '2026-11-12', fetchImpl: fakeFetch });
  assert.equal(systems.length, 2);
  assert.notEqual(systems[0], systems[1]);
  assert.ok(systems[1].includes('Compra Nova X'));
});

test('4 (D14): model always requesting tools stops at exactly 4 requests with format error', async () => {
  await setupEnv();
  let calls = 0;
  await ask('Loop infinito', {
    day: '2026-11-12',
    fetchImpl: async () => {
      calls++;
      return jsonRes({
        choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `tc-${calls}`, type: 'function', function: { name: 'simulate_purchase', arguments: '{"amount":10000,"installments":2}' } }] } }],
      });
    },
  });
  assert.equal(calls, 4);
  const ses = getChatSession();
  assert.equal(ses.messages[ses.messages.length - 1].role, 'error');
});

test('5 (D14): effort rejection + context error caps at <= 6 requests and next question takes 1', async () => {
  await setupEnv('high', 350);
  let totalCalls = 0;
  let q1Calls = 0;
  let q2Calls = 0;
  const fakeFetch = async (_u: any, init: any) => {
    totalCalls++;
    const b = JSON.parse(String(init?.body));
    if (totalCalls <= 5 && b.reasoning_effort) {
      q1Calls++;
      return jsonRes({ error: { param: 'reasoning_effort', message: 'unsupported reasoning_effort' } }, 400);
    }
    if (!String(b.messages[0].content).includes('lancamentos: 300 de 351')) {
      q1Calls++;
      return jsonRes({ error: { code: 'context_length_exceeded', message: 'maximum context length' } }, 400);
    }
    if (q2Calls === 0 && getChatSession().messages.filter((m) => m.role === 'user').length === 1) {
      q1Calls++;
      return jsonRes({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Resposta reduzida' } }] });
    }
    q2Calls++;
    assert.equal(b.reasoning_effort, undefined);
    return jsonRes({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Segunda ok' } }] });
  };
  await ask('Primeira', { day: '2026-11-12', fetchImpl: fakeFetch });
  assert.ok(q1Calls <= 6, `q1Calls=${q1Calls}`);
  assert.equal(getChatSession().txCap, 300);
  assert.equal(getChatSession().droppedEffort, true);
  await ask('Segunda', { day: '2026-11-12', fetchImpl: fakeFetch });
  assert.equal(q2Calls, 1);
});

test('6: context error retries once with txCap 300', async () => {
  await setupEnv('auto', 350);
  const caps: string[] = [];
  await ask('Resumo', {
    day: '2026-11-12',
    fetchImpl: async (_u, init) => {
      const sys = JSON.parse(String(init?.body)).messages[0].content as string;
      caps.push(sys);
      if (!sys.includes('lancamentos: 300 de 351')) {
        return jsonRes({ error: { code: 'context_length_exceeded', message: 'context exceeded' } }, 400);
      }
      return jsonRes({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Com 300 ok' } }] });
    },
  });
  assert.equal(caps.length, 2);
  assert.equal(getChatSession().txCap, 300);
  assert.equal(getChatSession().messages[1].text, 'Com 300 ok');
});

test('7: cancelChat and newConversation discard stale in-flight response', async () => {
  await setupEnv();
  let resolveFetch!: (r: Response) => void;
  const p = ask('Demorada', {
    day: '2026-11-12',
    fetchImpl: () => new Promise<Response>((res) => { resolveFetch = res; }),
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(getChatSession().pending, true);
  cancelChat();
  assert.equal(getChatSession().pending, false);
  resolveFetch(jsonRes({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Tardia' } }] }));
  await p;
  assert.equal(getChatSession().messages.some((m) => m.text === 'Tardia'), false);
  newConversation();
  assert.equal(getChatSession().messages.length, 0);
});

test('8: tools rejection sets session.noTools so next questions omit tools', async () => {
  await setupEnv();
  let hasToolsOnSecond = true;
  const fakeFetch = async (_u: any, init: any) => {
    const b = JSON.parse(String(init?.body));
    if (b.tools) return jsonRes({ error: { param: 'tools', message: 'tools not supported' } }, 400);
    if (getChatSession().messages.filter((m) => m.role === 'user').length === 2) hasToolsOnSecond = Boolean(b.tools);
    return jsonRes({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Sem tools' } }] });
  };
  await ask('Q1', { day: '2026-11-12', fetchImpl: fakeFetch });
  assert.equal(getChatSession().noTools, true);
  await ask('Q2', { day: '2026-11-12', fetchImpl: fakeFetch });
  assert.equal(hasToolsOnSecond, false);
});

test('9: history keeps no old snapshots and sends at most last 10 prior turns', async () => {
  await setupEnv();
  let sentCount = 0;
  const fakeFetch = async (_u: any, init: any) => {
    const msgs = JSON.parse(String(init?.body)).messages as any[];
    sentCount = msgs.length;
    assert.equal(msgs.filter((m) => String(m.content).includes('<snapshot>')).length, 1);
    return jsonRes({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Ok' } }] });
  };
  for (let i = 0; i < 7; i++) {
    await ask(`P${i}`, { day: '2026-11-12', fetchImpl: fakeFetch });
  }
  // 1 system + 10 prior messages + 1 new user = 12
  assert.equal(sentCount, 12);
  assert.equal(getChatSession().messages.some((m) => m.text.includes('<snapshot>')), false);
  setAiKeyStorage(null);
});

test('10 (X1/D14): effort + tools rejected then context error caps at <= 6 requests without resending rejected params', async () => {
  await setupEnv('high', 350);
  let calls = 0;
  let droppedEffortSeen = false;
  let droppedToolsSeen = false;
  const sentEffortsAfterDrop: unknown[] = [];
  const sentToolsAfterDrop: unknown[] = [];
  await ask('Posso parcelar algo?', {
    day: '2026-11-12',
    fetchImpl: async (_u: any, init: any) => {
      calls++;
      const b = JSON.parse(String(init?.body));
      if (droppedEffortSeen) sentEffortsAfterDrop.push(b.reasoning_effort);
      if (droppedToolsSeen) sentToolsAfterDrop.push(b.tools);
      if (b.reasoning_effort) {
        droppedEffortSeen = true;
        return jsonRes({ error: { param: 'reasoning_effort', message: 'unsupported reasoning_effort' } }, 400);
      }
      if (b.tools) {
        droppedToolsSeen = true;
        return jsonRes({ error: { param: 'tools', message: 'tools not supported' } }, 400);
      }
      if (!String(b.messages[0].content).includes('lancamentos: 300 de')) {
        return jsonRes({ error: { code: 'context_length_exceeded', message: 'maximum context length' } }, 400);
      }
      return jsonRes({
        choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `tc-${calls}`, type: 'function', function: { name: 'simulate_purchase', arguments: '{"amount":10000,"installments":2}' } }] } }],
      });
    },
  });
  const ses = getChatSession();
  assert.ok(calls <= 6, `calls=${calls}`);
  assert.equal(ses.messages[ses.messages.length - 1]?.role, 'error');
  assert.equal(sentEffortsAfterDrop.every((e) => e === undefined), true);
  assert.equal(sentToolsAfterDrop.every((t) => t === undefined), true);
  assert.equal(ses.noTools, true);
  setAiKeyStorage(null);
});
