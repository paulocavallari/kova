import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { makeNet, bank, testConn, tx } from './pluggy-fake';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.location = dom.window.location;
g.history = dom.window.history;
g.localStorage = dom.window.localStorage;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const store = await import('../src/lib/store');
const ui = await import('../src/components/PluggyUI');
const pluggy = await import('../src/lib/pluggy');
const { getT } = await import('../src/i18n');
const { initialState } = await import('../src/lib/defaults');
import type { PluggyConn, State } from '../src/lib/types';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const now = () => NOW;
function fixture(conns: PluggyConn[], lang: 'en' | 'pt' = 'en'): State {
  const s = initialState(lang);
  return { ...s, settings: { ...s.settings, lang }, pluggy: conns };
}
function conn(id: string, extra: Partial<PluggyConn> = {}): PluggyConn {
  return testConn(id, 'http://a.test', ['ia'], extra) as PluggyConn;
}
function fake(bankBalance = 900) {
  return makeNet({
    'http://a.test': {
      clientId: 'client-a',
      clientSecret: 'secret-a',
      items: [{ id: 'ia', name: 'Banco A', lastUpdatedAt: '2026-11-08T10:00:00.000Z', accounts: [{ account: bank('bank1', bankBalance), txs: [tx('t1', -10, '2026-11-05', { type: 'DEBIT', description: 'Padaria' })] }] }],
    },
  });
}
async function mount(): Promise<{ root: ReturnType<typeof createRoot>; box: HTMLElement; unmount: () => Promise<void> }> {
  const box = document.createElement('div');
  document.body.appendChild(box);
  const root = createRoot(box);
  await act(async () => { root.render(React.createElement(ui.PluggySettingsSheet)); });
  return {
    root,
    box,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      box.remove();
    },
  };
}
function click(box: HTMLElement, label: string) {
  const el = box.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
  assert.ok(el, `controle ${label} presente`);
  el!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}
function buttonWithText(box: HTMLElement, text: string) {
  return Array.from(box.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(text)) as HTMLButtonElement | undefined;
}

test('mounted sheet exposes enabled, automatic, test and linked-account controls', async () => {
  const net = fake();
  const original = globalThis.fetch;
  globalThis.fetch = net.fetchImpl;
  store.replaceState(fixture([conn('a')]));
  const view = await mount();
  try {
    assert.ok(view.box.querySelector('[role="switch"][aria-label="Automatic update"]'));
    assert.ok(view.box.querySelector('[role="switch"][aria-label="Connection active"]'));
    assert.ok(view.box.querySelector('[aria-label="Test connection"]'));
    assert.ok(view.box.querySelector('[aria-label="Sync"]'));
    assert.ok((view.box.textContent ?? '').includes('Automatic update'));
    assert.ok((view.box.textContent ?? '').includes('No account linked yet'));

    await act(async () => { click(view.box, 'Automatic update'); });
    assert.equal(store.getState().pluggy?.[0].auto, false);
    await act(async () => { click(view.box, 'Connection active'); });
    assert.equal(store.getState().pluggy?.[0].enabled, false);
  } finally {
    await view.unmount();
    globalThis.fetch = original;
  }
});

test('test connection validates without importing; sync imports and lists linked accounts', async () => {
  const net = fake();
  const original = globalThis.fetch;
  globalThis.fetch = net.fetchImpl;
  store.replaceState(fixture([conn('a')]));
  const view = await mount();
  try {
    await act(async () => {
      click(view.box, 'Test connection');
      await new Promise((r) => setTimeout(r, 30));
    });
    assert.equal(store.getState().accounts.filter((a) => a.pluggy).length, 0);
    assert.equal(store.getState().txs.length, 0);
    assert.equal(store.getState().pluggy?.[0].lastSyncAt, undefined);
    assert.ok(net.calls.includes('/items/ia'));
    assert.equal(net.calls.some((c) => c.startsWith('/v2/transactions')), false);

    await act(async () => {
      click(view.box, 'Sync');
      await new Promise((r) => setTimeout(r, 30));
    });
    assert.equal(store.getState().accounts.filter((a) => a.pluggy).length, 1);
    assert.equal(store.getState().txs.length, 1);
    assert.ok((view.box.textContent ?? '').includes('bank1'));
  } finally {
    await view.unmount();
    globalThis.fetch = original;
  }
});

test('re-activating a restored connection after re-entering the secret', async () => {
  store.replaceState(fixture([conn('a', { clientSecret: '', enabled: false })]));
  const view = await mount();
  try {
    const open = buttonWithText(view.box, 'API a');
    assert.ok(open);
    await act(async () => { open!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    const secret = view.box.querySelector('input[type="password"]') as HTMLInputElement;
    assert.ok(secret);
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(secret, 'secret-a');
      secret.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      click(view.box, 'Connection active');
    });
    const save = buttonWithText(view.box, 'Save');
    assert.ok(save);
    await act(async () => { save!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    const saved = store.getState().pluggy?.[0];
    assert.equal(saved?.clientSecret, 'secret-a');
    assert.equal(saved?.enabled, true);
  } finally {
    await view.unmount();
  }
});

test('error categories are translated in pt and en', async () => {
  store.replaceState(fixture([], 'pt'));
  assert.match(getT()('pluggyErrAuth'), /client ID/);
  assert.match(getT()('pluggyAuto'), /Atualização automática/);
  assert.equal(ui.pluggyErrorLabel(getT(), 'pluggy: HTTP 401'), getT()('pluggyErrAuth'));
  assert.equal(ui.pluggyErrorLabel(getT(), 'pluggy: HTTP 500'), getT()('pluggyErrData'));
  assert.equal(ui.pluggyErrorLabel(getT(), 'pluggy: invalid base url'), getT()('pluggyErrConfig'));
  store.replaceState(fixture([], 'en'));
  assert.match(getT()('pluggyErrGeneric'), /Pluggy/);
});

test('real maintenance and visibilitychange paths import through atomic application', async () => {
  const net = fake();
  const original = globalThis.fetch;
  globalThis.fetch = net.fetchImpl;
  const old = { ...conn('a', { lastSyncAt: new Date(NOW - 2 * 24 * 3600_000).toISOString() }), auto: true };
  const seeded = fixture([old]);
  seeded.settings = { ...seeded.settings, onboarded: false, autoBackup: false };
  dom.window.localStorage.setItem('kova-state-v1', JSON.stringify(seeded));
  await store.loadState();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(store.getState().accounts.filter((a) => a.pluggy).length, 1);

  const second = fixture([{ ...old, id: 'b', name: 'API b', baseUrl: 'http://a.test', lastSyncAt: new Date(NOW - 2 * 24 * 3600_000).toISOString() }]);
  second.accounts = store.getState().accounts;
  second.txs = store.getState().txs;
  store.replaceState(second);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  await act(async () => {
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 250));
  });
  assert.ok(store.getState().accounts.some((a) => a.pluggy?.apiId === 'b'));
  globalThis.fetch = original;
});

test('timer makes no calls when automatic update is off and stops on cleanup', async () => {
  const net = fake();
  let current = fixture([conn('a', { auto: false })]);
  const apply = (fn: (s: State) => State) => { current = fn(current); };
  const before = current;
  const stop = pluggy.startPluggyAutoSync(() => current, apply, { now, fetchImpl: net.fetchImpl, intervalMs: 15 });
  await new Promise((r) => setTimeout(r, 40));
  stop();
  assert.equal(net.calls.length, 0);
  assert.equal(current, before);
});
