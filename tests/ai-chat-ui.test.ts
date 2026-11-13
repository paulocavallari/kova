import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, mount, setInput, click, buttonWithText } from './ai-dom';
import { initialState } from '../src/lib/defaults';
import { replaceState } from '../src/lib/store';
import { setAiKey, setAiKeyStorage } from '../src/lib/ai-config';
import { resetChatSession } from '../src/lib/ai-chat';
import { Chat } from '../src/screens/Chat';

const BASE_URL = 'https://api.example.test/v1';
const FAKE_KEY = 'TESTKEY-AAAA-0000';

const origFetch = globalThis.fetch;
(globalThis as any).fetch = async () => {
  throw new Error('rede proibida');
};

async function setupChatEnv(configured = true) {
  resetChatSession();
  const map = new Map<string, unknown>();
  setAiKeyStorage({ get: async (k) => map.get(k) as any, set: async (k, v) => { map.set(k, v); } });
  const s = initialState('pt');
  replaceState({
    ...s,
    settings: {
      ...s.settings,
      lang: 'pt',
      onboarded: true,
      ...(configured ? { ai: { baseUrl: BASE_URL, model: 'm-1', effort: 'auto' as const } } : {}),
    },
  });
  if (configured) await setAiKey(FAKE_KEY);
}

test('unconfigured state shows configure button that opens AiSettingsSheet', async () => {
  await setupChatEnv(false);
  const view = await mount(React.createElement(Chat));
  try {
    assert.match(view.box.textContent ?? '', /Configure a IA primeiro/);
    await act(async () => {
      click(buttonWithText(view.box, 'Configurar IA'));
    });
    assert.match(view.box.textContent ?? '', /Base URL/);
  } finally {
    await view.unmount();
    setAiKeyStorage(null);
  }
});

test('header shows provider host, token estimate per request and 2 a 4 envios', async () => {
  await setupChatEnv(true);
  const view = await mount(React.createElement(Chat));
  try {
    const text = view.box.textContent ?? '';
    assert.match(text, /api\.example\.test/);
    assert.match(text, /≈ \d+ mil tokens por envio/);
    assert.match(text, /2 a 4 envios/);
  } finally {
    await view.unmount();
    setAiKeyStorage(null);
  }
});

test('send question displays user and assistant plain-text bubbles', async () => {
  await setupChatEnv(true);
  (globalThis as any).fetch = async () =>
    new Response(
      JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Folga de R$ 1.200,00.' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const view = await mount(React.createElement(Chat));
  try {
    const input = view.box.querySelector('input[type="text"], textarea') as HTMLInputElement | HTMLTextAreaElement;
    await act(async () => {
      setInput(input, 'Como estou este mês?');
    });
    await act(async () => {
      click(buttonWithText(view.box, 'Enviar'));
      await new Promise((r) => setTimeout(r, 20));
    });
    const text = view.box.textContent ?? '';
    assert.ok(text.includes('Como estou este mês?'));
    assert.ok(text.includes('Folga de R$ 1.200,00.'));
  } finally {
    await view.unmount();
    setAiKeyStorage(null);
    (globalThis as any).fetch = origFetch;
  }
});

test('provider error shows error bubble without breaking the screen', async () => {
  await setupChatEnv(true);
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  const view = await mount(React.createElement(Chat));
  try {
    await act(async () => {
      click(buttonWithText(view.box, 'Posso comprar R$ 3.000 em 10x?'));
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.ok(view.box.querySelector('.chat-msg.error'));
    assert.match(view.box.textContent ?? '', /Chave de API inválida/);
  } finally {
    await view.unmount();
    setAiKeyStorage(null);
    (globalThis as any).fetch = origFetch;
  }
});

test('send button is disabled while pending and re-enabled after completion', async () => {
  await setupChatEnv(true);
  let resolveFetch!: (r: Response) => void;
  (globalThis as any).fetch = () => new Promise<Response>((res) => { resolveFetch = res; });
  const view = await mount(React.createElement(Chat));
  try {
    const input = view.box.querySelector('input[type="text"], textarea') as HTMLInputElement | HTMLTextAreaElement;
    await act(async () => {
      setInput(input, 'Pergunta');
    });
    const sendBtn = buttonWithText(view.box, 'Enviar');
    await act(async () => {
      click(sendBtn);
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.equal(sendBtn.disabled, true);
    assert.match(view.box.textContent ?? '', /Pensando/);
    await act(async () => {
      resolveFetch(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Pronto.' } }] }), { status: 200 }));
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.ok((view.box.textContent ?? '').includes('Pronto.'));
  } finally {
    await view.unmount();
    setAiKeyStorage(null);
    (globalThis as any).fetch = origFetch;
  }
});

test('Nova conversa clears messages', async () => {
  await setupChatEnv(true);
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Resposta 1' } }] }), { status: 200 });
  const view = await mount(React.createElement(Chat));
  try {
    await act(async () => {
      click(buttonWithText(view.box, 'Como estão meus próximos 12 meses?'));
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.ok((view.box.textContent ?? '').includes('Resposta 1'));
    await act(async () => {
      click(buttonWithText(view.box, 'Nova conversa'));
    });
    assert.equal((view.box.textContent ?? '').includes('Resposta 1'), false);
  } finally {
    await view.unmount();
    setAiKeyStorage(null);
    (globalThis as any).fetch = origFetch;
  }
});
