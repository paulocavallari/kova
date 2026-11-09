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
g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
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
const { openAccountEditor } = await import('../src/components/Editors');
const { OverlayHost } = await import('../src/components/ui');
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
function fake(bankBalance = 900, remoteName = 'Conta') {
  return makeNet({
    'http://a.test': {
      clientId: 'client-a',
      clientSecret: 'secret-a',
      items: [{ id: 'ia', name: 'Banco A', lastUpdatedAt: '2026-11-08T10:00:00.000Z', accounts: [{ account: bank('bank1', bankBalance, 'BRL', remoteName), txs: [tx('t1', -10, '2026-11-05', { type: 'DEBIT', description: 'Padaria' })] }] }],
    },
  });
}
async function syncRemoteName(name: string) {
  const net = fake(900, name);
  const original = globalThis.fetch;
  globalThis.fetch = net.fetchImpl;
  try {
    const ok = await ui.runPluggySync('a');
    assert.equal(ok, true);
  } finally {
    globalThis.fetch = original;
  }
}
function importedNameFixture(name: string): State {
  const s = fixture([conn('a')]);
  const account = {
    id: 'pg-a-bank1', name, icon: 'bank', color: '#3D8BFF', currency: 'BRL', initial: 0,
    includeInTotal: true, archived: false, order: 2,
    pluggy: { apiId: 'a', accountId: 'bank1', type: 'BANK', lastAutoName: name },
  };
  return { ...s, accounts: [...s.accounts, account] };
}
function lastSheet(box: HTMLElement) {
  const sheets = box.querySelectorAll('.sheet');
  return sheets[sheets.length - 1] as HTMLElement;
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
function setTextarea(el: HTMLTextAreaElement, value: string, selection?: number) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(el, value);
  if (selection !== undefined) el.setSelectionRange(selection, selection);
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}
function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}
async function openAddForm(box: HTMLElement) {
  const add = buttonWithText(box, 'Add API');
  assert.ok(add, 'botão Add API presente');
  await act(async () => { add!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  const textarea = box.querySelector('textarea') as HTMLTextAreaElement;
  assert.ok(textarea, 'textarea de Item IDs presente');
  return textarea;
}
async function fillRequired(box: HTMLElement) {
  const inputs = Array.from(box.querySelectorAll('input'));
  const name = inputs.find((i) => i.type === 'text') as HTMLInputElement;
  await act(async () => { setInput(name, 'API nova'); });
  const all = Array.from(box.querySelectorAll('input'));
  const clientId = all.find((i) => i.type === 'text' && i !== name) as HTMLInputElement;
  await act(async () => { setInput(clientId, 'client-new'); });
  const secret = box.querySelector('input[type="password"]') as HTMLInputElement;
  await act(async () => { setInput(secret, 'secret-new'); });
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

test('item IDs textarea keeps separators and cursor while typing, normalizing only on save', async () => {
  store.replaceState(fixture([]));
  const view = await mount();
  try {
    const textarea = await openAddForm(view.box);
    for (const value of ['a', 'a,', 'a,b', 'a,b\n']) {
      await act(async () => { setTextarea(textarea, value); });
      assert.equal(textarea.value, value, `valor preservado após ${JSON.stringify(value)}`);
    }
    await act(async () => { setTextarea(textarea, 'a,c', 1); });
    await act(async () => { setTextarea(textarea, 'ab,c', 2); });
    assert.equal(textarea.value, 'ab,c');
    assert.equal(textarea.selectionStart, 2, 'cursor preservado na inserção do meio');
    await act(async () => { setTextarea(textarea, ' id1, id2 \n id3 \r\n '); });
    assert.equal(textarea.value.replace(/\r\n/g, '\n'), ' id1, id2 \n id3 \n ');
    await fillRequired(view.box);
    const save = buttonWithText(view.box, 'Save');
    await act(async () => { save!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    assert.deepEqual(store.getState().pluggy?.[0].itemIds, ['id1', 'id2', 'id3']);
  } finally {
    await view.unmount();
  }
});

test('editing an existing connection keeps separators in the textarea and saves the exact array', async () => {
  store.replaceState(fixture([conn('a')]));
  const view = await mount();
  try {
    const open = buttonWithText(view.box, 'API a');
    assert.ok(open);
    await act(async () => { open!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    const textarea = view.box.querySelector('textarea') as HTMLTextAreaElement;
    assert.equal(textarea.value, 'ia');
    await act(async () => { setTextarea(textarea, 'ia,\nib,'); });
    assert.equal(textarea.value, 'ia,\nib,');
    const save = buttonWithText(view.box, 'Save');
    await act(async () => { save!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    const saved = store.getState().pluggy?.[0];
    assert.deepEqual(saved?.itemIds, ['ia', 'ib']);
    assert.equal(saved?.clientSecret, 'secret-a');
    assert.equal(saved?.name, 'API a');
  } finally {
    await view.unmount();
  }
});

function accountFixture(): State {
  const s = fixture([]);
  return {
    ...s,
    accounts: [
      ...s.accounts,
      {
        id: 'pg-a-bank1',
        name: 'Banco A',
        icon: 'bank',
        color: '#3D8BFF',
        currency: 'BRL',
        initial: 0,
        includeInTotal: true,
        archived: false,
        order: 2,
        note: 'conta importada',
        pluggy: { apiId: 'a', accountId: 'bank1', type: 'BANK', lastAutoName: 'Banco A' },
      },
      {
        id: 'wallet-2',
        name: 'Carteira comum',
        icon: 'wallet',
        color: '#7C5CFF',
        currency: 'BRL',
        initial: 0,
        includeInTotal: true,
        archived: false,
        order: 3,
      },
    ],
  };
}

async function mountOverlayHost() {
  const box = document.createElement('div');
  document.body.appendChild(box);
  const root = createRoot(box);
  await act(async () => { root.render(React.createElement(OverlayHost)); });
  return {
    box,
    root,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      box.remove();
    },
  };
}

async function editAccount(accId: string, change: (root: HTMLElement) => Promise<void>) {
  store.replaceState(accountFixture());
  const acc = store.getState().accounts.find((a) => a.id === accId);
  const view = await mountOverlayHost();
  await act(async () => { openAccountEditor(acc); });
  const sheets = view.box.querySelectorAll('.sheet');
  const root = sheets[sheets.length - 1] as HTMLElement;
  await change(root);
  const save = buttonWithText(root, 'Save');
  assert.ok(save, 'botão Save do editor presente');
  await act(async () => {
    save!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
  });
  return { view, saved: store.getState().accounts.find((a) => a.id === accId) };
}

test('account editor preserves the Pluggy link and marks only real name changes', async () => {
  const renamed = await editAccount('pg-a-bank1', async (box) => {
    const input = box.querySelector('input') as HTMLInputElement;
    assert.ok(input);
    await act(async () => { setInput(input, 'Minha conta'); });
  });
  try {
    assert.equal(renamed.saved?.name, 'Minha conta');
    assert.equal(renamed.saved?.pluggy?.apiId, 'a');
    assert.equal(renamed.saved?.pluggy?.accountId, 'bank1');
    assert.equal(renamed.saved?.pluggy?.lastAutoName, 'Banco A');
    assert.equal(renamed.saved?.pluggy?.nameCustomized, true);
    assert.equal(renamed.saved?.note, 'conta importada');
  } finally {
    await renamed.view.unmount();
  }

  const colorOnly = await editAccount('pg-a-bank1', async (box) => {
    const includeSwitch = box.querySelector('[role="switch"]') as HTMLButtonElement;
    assert.ok(includeSwitch);
    await act(async () => { includeSwitch.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  });
  try {
    assert.equal(colorOnly.saved?.name, 'Banco A');
    assert.equal(colorOnly.saved?.pluggy?.nameCustomized, undefined);
    assert.equal(colorOnly.saved?.includeInTotal, false);
  } finally {
    await colorOnly.view.unmount();
  }

  const common = await editAccount('wallet-2', async (box) => {
    const input = box.querySelector('input') as HTMLInputElement;
    await act(async () => { setInput(input, 'Carteira editada'); });
  });
  try {
    assert.equal(common.saved?.name, 'Carteira editada');
    assert.equal(common.saved?.pluggy, undefined);
  } finally {
    await common.view.unmount();
  }
});

test('saving another field after a concurrent sync keeps the live automatic name', async () => {
  store.replaceState(importedNameFixture('Nome 1'));
  const view = await mountOverlayHost();
  try {
    const opening = store.getState().accounts.find((a) => a.id === 'pg-a-bank1');
    await act(async () => { openAccountEditor(opening); });
    await syncRemoteName('Nome 2');
    assert.equal(store.getState().accounts.find((a) => a.id === 'pg-a-bank1')?.name, 'Nome 2');

    const root = lastSheet(view.box);
    const includeSwitch = root.querySelector('[role="switch"]') as HTMLButtonElement;
    await act(async () => { includeSwitch.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    const save = buttonWithText(root, 'Save');
    await act(async () => {
      save!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });
    let saved = store.getState().accounts.find((a) => a.id === 'pg-a-bank1')!;
    assert.equal(saved.name, 'Nome 2');
    assert.equal(saved.includeInTotal, false);
    assert.equal(saved.pluggy?.lastAutoName, 'Nome 2');
    assert.equal(saved.pluggy?.nameCustomized, undefined);

    await syncRemoteName('Nome 3');
    saved = store.getState().accounts.find((a) => a.id === 'pg-a-bank1')!;
    assert.equal(saved.name, 'Nome 3');
    assert.equal(saved.pluggy?.lastAutoName, 'Nome 3');

    await act(async () => { openAccountEditor(store.getState().accounts.find((a) => a.id === 'pg-a-bank1')); });
    const editRoot = lastSheet(view.box);
    const nameInput = editRoot.querySelector('input') as HTMLInputElement;
    await act(async () => { setInput(nameInput, 'Meu nome'); });
    const saveCustom = buttonWithText(editRoot, 'Save');
    await act(async () => {
      saveCustom!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });
    await syncRemoteName('Nome 4');
    saved = store.getState().accounts.find((a) => a.id === 'pg-a-bank1')!;
    assert.equal(saved.name, 'Meu nome');
    assert.equal(saved.pluggy?.nameCustomized, true);
    assert.equal(saved.pluggy?.lastAutoName, 'Nome 3');
  } finally {
    await view.unmount();
  }
});

test('editing origin configuration clears bill caches; auto toggle keeps them', async () => {
  const c = conn('a');
  const account = {
    id: 'pg-a-card1', name: 'Cartão', icon: 'cards', color: '#B57BFF', currency: 'BRL', initial: 0,
    includeInTotal: true, archived: false, order: 2,
    pluggy: { apiId: 'a', accountId: 'card1', type: 'CREDIT', bills: { status: 'fresh' as const, fetchedAt: '2026-11-09T00:00:00.000Z', items: [{ id: 'b1', dueDate: '2026-11-05', amountCents: 1000, currency: 'BRL' }] } },
  };
  const base = fixture([c]);
  store.replaceState({ ...base, accounts: [...base.accounts, account] });
  ui.patchPluggyConn('a', { auto: false });
  const cached = () => store.getState().accounts.find((a) => a.id === 'pg-a-card1')?.pluggy?.bills;
  assert.ok(cached());
  ui.patchPluggyConn('a', { clientId: 'other' });
  assert.equal(cached(), undefined);

  store.replaceState({ ...base, accounts: [...base.accounts, account] });
  ui.savePluggyConn({ ...c, baseUrl: 'https://proxy.example' });
  assert.equal(cached(), undefined);
});
