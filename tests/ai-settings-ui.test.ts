import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, mount, setInput, setSelect, click, buttonWithText } from './ai-dom';
import { initialState } from '../src/lib/defaults';
import { getState, replaceState } from '../src/lib/store';
import { getAiKey, setAiKey, setAiKeyStorage } from '../src/lib/ai-config';
import { AiSettingsSheet } from '../src/components/AiUI';
import { Settings } from '../src/screens/Settings';
import type { AiEffort } from '../src/lib/types';

const FAKE_KEY = 'TESTKEY-AAAA-0000';
const BASE_URL = 'https://api.example.test/v1';

const origFetch = globalThis.fetch;
(globalThis as any).fetch = async () => {
  throw new Error('rede proibida');
};

function setupState(lang: 'en' | 'pt' = 'pt', ai?: { baseUrl: string; model: string; effort: AiEffort }) {
  const s = initialState(lang);
  replaceState({ ...s, settings: { ...s.settings, lang, onboarded: true, ...(ai ? { ai } : {}) } });
}

function memStorage() {
  const map = new Map<string, unknown>();
  setAiKeyStorage({
    get: async (k) => map.get(k) as any,
    set: async (k, v) => { map.set(k, v); },
  });
  return map;
}

test('fetching models populates select and updates effort options by supported_efforts', async () => {
  memStorage();
  setupState('pt');
  (globalThis as any).fetch = async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: 'm-reasoning', reasoning: { supported_efforts: ['none', 'low', 'high'], mandatory: true } },
          { id: 'm-plain' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  const view = await mount(React.createElement(AiSettingsSheet));
  try {
    const urlInput = view.box.querySelector('input[type="url"], input[type="text"]') as HTMLInputElement;
    const keyInput = view.box.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => {
      setInput(urlInput, BASE_URL);
      setInput(keyInput, FAKE_KEY);
    });
    await act(async () => {
      click(buttonWithText(view.box, 'Buscar modelos'));
      await new Promise((r) => setTimeout(r, 20));
    });

    const select = view.box.querySelector('select') as HTMLSelectElement;
    assert.ok(select);
    const options = Array.from(select.options).map((o) => o.value);
    assert.deepEqual(options, ['m-plain', 'm-reasoning']);

    await act(async () => {
      setSelect(select, 'm-reasoning');
    });
    const segButtons = Array.from(view.box.querySelectorAll('.seg button')).map((b) => b.textContent);
    assert.deepEqual(segButtons, ['Automático', 'low', 'high']);
  } finally {
    await view.unmount();
    setAiKeyStorage(null);
    (globalThis as any).fetch = origFetch;
  }
});

test('effort falls back to default list for models without metadata', async () => {
  memStorage();
  setupState('pt', { baseUrl: BASE_URL, model: 'm-plain', effort: 'medium' });
  const view = await mount(React.createElement(AiSettingsSheet));
  try {
    const segButtons = Array.from(view.box.querySelectorAll('.seg button')).map((b) => b.textContent);
    assert.deepEqual(segButtons, ['Automático', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  } finally {
    await view.unmount();
    setAiKeyStorage(null);
  }
});

test('saving persists settings.ai without key in State and shows 2 a 4 vezes warning', async () => {
  memStorage();
  setupState('pt');
  const view = await mount(React.createElement(AiSettingsSheet));
  try {
    assert.ok((view.box.textContent ?? '').includes('2 a 4 vezes'));
    const inputs = Array.from(view.box.querySelectorAll('input'));
    const urlInput = inputs[0] as HTMLInputElement;
    const keyInput = view.box.querySelector('input[type="password"]') as HTMLInputElement;
    const modelInput = inputs.find((i) => i !== urlInput && i !== keyInput) as HTMLInputElement;
    await act(async () => {
      setInput(urlInput, `${BASE_URL}/chat/completions`);
      setInput(keyInput, FAKE_KEY);
      setInput(modelInput, 'm-alpha');
    });
    await act(async () => {
      click(buttonWithText(view.box, 'Salvar'));
      await new Promise((r) => setTimeout(r, 20));
    });

    assert.deepEqual(getState().settings.ai, { baseUrl: BASE_URL, model: 'm-alpha', effort: 'auto' });
    assert.equal(JSON.stringify(getState()).includes(FAKE_KEY), false);
    assert.equal(await getAiKey(), FAKE_KEY);
  } finally {
    await view.unmount();
    setAiKeyStorage(null);
  }
});

test('removing key clears saved secret and placeholder', async () => {
  memStorage();
  await setAiKey(FAKE_KEY);
  setupState('pt', { baseUrl: BASE_URL, model: 'm-alpha', effort: 'auto' });
  const view = await mount(React.createElement(AiSettingsSheet));
  try {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
    const keyInput = view.box.querySelector('input[type="password"]') as HTMLInputElement;
    assert.equal(keyInput.placeholder, '••••••');
    await act(async () => {
      click(buttonWithText(view.box, 'Remover chave'));
      await new Promise((r) => setTimeout(r, 15));
    });
    assert.equal(await getAiKey(), undefined);
    assert.equal(keyInput.placeholder, '');
  } finally {
    await view.unmount();
    setAiKeyStorage(null);
  }
});

test('fetch models error shows clear message and keeps free-text model input', async () => {
  memStorage();
  setupState('pt');
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ error: { message: `bad ${FAKE_KEY}` } }), { status: 401 });
  const view = await mount(React.createElement(AiSettingsSheet));
  try {
    const urlInput = view.box.querySelector('input[type="url"], input[type="text"]') as HTMLInputElement;
    const keyInput = view.box.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => {
      setInput(urlInput, BASE_URL);
      setInput(keyInput, FAKE_KEY);
    });
    await act(async () => {
      click(buttonWithText(view.box, 'Buscar modelos'));
      await new Promise((r) => setTimeout(r, 20));
    });
    const text = view.box.textContent ?? '';
    assert.equal(text.includes(FAKE_KEY), false);
    assert.match(text, /chave|autentica/i);
    assert.equal(view.box.querySelector('select'), null);
    assert.ok(view.box.querySelectorAll('input').length >= 3);
  } finally {
    await view.unmount();
    setAiKeyStorage(null);
    (globalThis as any).fetch = origFetch;
  }
});

test('N2: erasing all data from Settings clears AI key and settings.ai', async () => {
  memStorage();
  await setAiKey(FAKE_KEY);
  setupState('en', { baseUrl: BASE_URL, model: 'm-alpha', effort: 'low' });
  const view = await mount(React.createElement(Settings));
  try {
    await act(async () => {
      click(buttonWithText(view.box, 'Erase all data'));
    });
    const btns = Array.from(view.box.querySelectorAll('button')).filter((b) => (b.textContent ?? '').includes('Erase all data'));
    await act(async () => {
      click(btns[btns.length - 1]);
      await new Promise((r) => setTimeout(r, 30));
    });
    assert.equal(await getAiKey(), undefined);
    assert.equal(getState().settings.ai, undefined);
  } finally {
    await view.unmount();
    setAiKeyStorage(null);
  }
});

test('N2: when clearAiKey fails during erase, shows warning toast and still erases State', async () => {
  setAiKeyStorage({
    get: async () => FAKE_KEY,
    set: async () => { throw new Error('idb locked'); },
  });
  setupState('en', { baseUrl: BASE_URL, model: 'm-alpha', effort: 'low' });
  const view = await mount(React.createElement(Settings));
  try {
    await act(async () => {
      click(buttonWithText(view.box, 'Erase all data'));
    });
    const btns = Array.from(view.box.querySelectorAll('button')).filter((b) => (b.textContent ?? '').includes('Erase all data'));
    await act(async () => {
      click(btns[btns.length - 1]);
      await new Promise((r) => setTimeout(r, 30));
    });
    assert.equal(getState().settings.ai, undefined);
    assert.match(view.box.textContent ?? '', /AI key could not be removed/i);
  } finally {
    await view.unmount();
    setAiKeyStorage(null);
  }
});

test('Q1: when setAiKey fails during save, shows error and does not save settings.ai', async () => {
  setAiKeyStorage({
    get: async () => '',
    set: async () => { throw new Error('idb locked'); },
  });
  setupState('en');
  let done = false;
  const view = await mount(React.createElement(AiSettingsSheet, { onDone: () => { done = true; } }));
  try {
    const urlInput = view.box.querySelector('input[type="url"]') as HTMLInputElement;
    const keyInput = view.box.querySelector('input[type="password"]') as HTMLInputElement;
    const modelInput = view.box.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      setInput(urlInput, BASE_URL);
      setInput(keyInput, FAKE_KEY);
      setInput(modelInput, 'm-alpha');
    });
    await act(async () => {
      click(buttonWithText(view.box, 'Save'));
      await new Promise((r) => setTimeout(r, 20));
    });
    assert.equal(done, false);
    assert.equal(getState().settings.ai, undefined);
    assert.match(view.box.textContent ?? '', /AI key could not be saved/i);
  } finally {
    await view.unmount();
    setAiKeyStorage(null);
  }
});
