import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { State } from '../src/lib/types';

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
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const store = await import('../src/lib/store');
const { Home } = await import('../src/screens/Home');
const { Accounts } = await import('../src/screens/Accounts');
const { OverlayHost } = await import('../src/components/ui');
const { initialState } = await import('../src/lib/defaults');
const { setDaySourceForTest } = await import('../src/lib/useToday');

function fixture(negative = false): State {
  const s = initialState('pt');
  return {
    ...s,
    settings: { ...s.settings, baseCurrency: 'BRL', lang: 'pt', monthlyCardView: undefined },
    accounts: [
      { id: 'bank', name: 'Conta', icon: 'bank', color: '#3D8BFF', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 0 },
      {
        id: 'card', name: 'Cartão', icon: 'cards', color: '#B57BFF', currency: 'BRL', initial: -900000, includeInTotal: true, archived: false, order: 1,
        pluggy: { apiId: 'a', accountId: 'card', type: 'CREDIT', bills: { status: 'fresh', fetchedAt: '2026-11-09T00:00:00.000Z', items: [{ id: 'b1', dueDate: '2026-11-05', amountCents: negative ? -30000 : 30000, currency: 'BRL' }] } },
      },
      { id: 'manual', name: 'Cartão manual', icon: 'cards', color: '#FFB020', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 2 },
    ],
    txs: [
      { id: 'in', kind: 'income', accountId: 'bank', categoryId: 'salary', amount: 500000, base: 500000, date: '2026-11-01', note: '', tags: [], created: '2026-11-01T12:00:00.000Z' },
      { id: 'out', kind: 'expense', accountId: 'bank', categoryId: 'food', amount: 100000, base: 100000, date: '2026-11-02', note: '', tags: [], created: '2026-11-02T12:00:00.000Z' },
      { id: 'm1', kind: 'expense', accountId: 'manual', categoryId: 'food', amount: 7000, base: 7000, date: '2026-11-03', note: '', tags: [], created: '2026-11-03T12:00:00.000Z' },
      { id: 'm2', kind: 'income', accountId: 'manual', categoryId: 'other_income', amount: 1000, base: 1000, date: '2026-11-04', note: '', tags: [], created: '2026-11-04T12:00:00.000Z' },
    ],
    transfers: [],
  };
}

async function mount(el: React.ReactElement) {
  const box = document.createElement('div');
  document.body.appendChild(box);
  const root = createRoot(box);
  await act(async () => { root.render(el); });
  return {
    box,
    unmount: async () => { await act(async () => { root.unmount(); }); box.remove(); },
  };
}
const text = (box: HTMLElement) => (box.textContent ?? '').replace(/\s+/g, ' ');

test('Home and Accounts share the monthly toggle and show bills by due date', async () => {
  store.replaceState(fixture());
  const before = JSON.stringify({ accounts: store.getState().accounts, txs: store.getState().txs, transfers: store.getState().transfers });
  const home = await mount(React.createElement(React.Fragment, null, React.createElement(Home), React.createElement(OverlayHost)));
  try {
    assert.match(text(home.box), /Resultado do mês/);
    assert.match(text(home.box), /3\.640,00/);
    const toggle = home.box.querySelector('[role="switch"][aria-label="Visão mensal dos cartões"]') as HTMLButtonElement;
    assert.ok(toggle);
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.equal(toggle.tagName, 'BUTTON');

    const accounts = await mount(React.createElement(Accounts));
    try {
      assert.match(text(accounts.box), /Fatura que vence neste mês/);
      assert.match(text(accounts.box), /300,00/);
      assert.match(text(accounts.box), /4\.000,00/);
      assert.match(text(accounts.box), /Cartões mostram a fatura/);
      const accToggle = accounts.box.querySelector('[role="switch"][aria-label="Visão mensal dos cartões"]') as HTMLButtonElement;
      await act(async () => { accToggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
      assert.equal(store.getState().settings.monthlyCardView, false);
      assert.doesNotMatch(text(accounts.box), /Fatura que vence neste mês/);
      assert.match(text(accounts.box), /Saldo total|Conta/);
    } finally {
      await accounts.unmount();
    }

    // the same store setting drives Home; remount simulates reload persistence
    store.replaceState(store.getState());
    const after = await mount(React.createElement(Home));
    try {
      assert.match(text(after.box), /Saldo total/);
      assert.doesNotMatch(text(after.box), /3\.640,00/);
    } finally {
      await after.unmount();
    }
  } finally {
    await home.unmount();
  }
  assert.equal(JSON.stringify({ accounts: store.getState().accounts, txs: store.getState().txs, transfers: store.getState().transfers }), before);
});

test('negative bill is unavailable and hides the monthly result honestly', async () => {
  store.replaceState(fixture(true));
  const home = await mount(React.createElement(Home));
  try {
    assert.match(text(home.box), /Incompleto/);
    assert.doesNotMatch(text(home.box), /3\.640,00/);
    const accounts = await mount(React.createElement(Accounts));
    try {
      assert.match(text(accounts.box), /Fatura indisponível/);
    } finally {
      await accounts.unmount();
    }
  } finally {
    await home.unmount();
  }
});

test('hideBalance conceals monthly values and the selected account uses its currency', async () => {
  const s = fixture();
  s.settings = { ...s.settings, hideBalance: true };
  store.replaceState(s);
  const home = await mount(React.createElement(React.Fragment, null, React.createElement(Home), React.createElement(OverlayHost)));
  try {
    assert.match(text(home.box), /••••••/);
    assert.doesNotMatch(text(home.box), /3\.640,00/);
    assert.doesNotMatch(text(home.box), /5\.000,00/);
    assert.doesNotMatch(text(home.box), /1\.300,00/);
    assert.doesNotMatch(text(home.box), /74%/);
    s.settings = { ...s.settings, hideBalance: false };
    store.replaceState(s);
    await act(async () => {});
    const picker = Array.from(home.box.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Resultado do mês') || (b.textContent ?? '').includes('Total'));
    assert.ok(picker);
    await act(async () => { picker!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    const cardButton = Array.from(home.box.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Cartão') && (b.textContent ?? '').includes('R$'));
    assert.ok(cardButton);
    await act(async () => { cardButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    assert.match(text(home.box), /300,00/);
  } finally {
    await home.unmount();
  }
});

test('selector uses the monthly projection, not the accumulated balance', async () => {
  store.replaceState(fixture());
  const home = await mount(React.createElement(React.Fragment, null, React.createElement(Home), React.createElement(OverlayHost)));
  try {
    const picker = home.box.querySelector('button.acct') as HTMLButtonElement;
    assert.ok(picker);
    await act(async () => { picker!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    const card = Array.from(home.box.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Cartão') && (b.textContent ?? '').includes('R$'));
    assert.ok(card);
    assert.match((card!.textContent ?? '').replace(/\s+/g, ' '), /300,00/);
    assert.doesNotMatch((card!.textContent ?? '').replace(/\s+/g, ' '), /9\.000,00/);
  } finally {
    await home.unmount();
  }
});

test('stale cache shows explicit date on both screens; rollover refreshes the civil day', async () => {
  const staleState = fixture();
  const card = staleState.accounts.find((a) => a.id === 'card')!;
  card.pluggy!.bills = { ...card.pluggy!.bills!, status: 'stale', fetchedAt: '2026-11-09T10:30:00.000Z' };
  store.replaceState(staleState);
  const accounts = await mount(React.createElement(Accounts));
  assert.match(text(accounts.box), /Desatualizado — última atualização/);
  assert.match(text(accounts.box), /09\/11\/2026/);
  await accounts.unmount();
  const home = await mount(React.createElement(Home));
  assert.match(text(home.box), /Desatualizado — última atualização/);
  assert.match(text(home.box), /3\.640,00/);
  await home.unmount();

  setDaySourceForTest(() => '2026-11-30');
  try {
    const s = fixture();
    const c = s.accounts.find((a) => a.id === 'card')!;
    c.pluggy!.bills!.items.push({ id: 'dec', dueDate: '2026-12-05', amountCents: 40000, currency: 'BRL' });
    store.replaceState(s);
    const view = await mount(React.createElement(Home));
    try {
    assert.match(text(view.box), /1\.360,00/);
    setDaySourceForTest(() => '2026-12-01');
    await act(async () => {
      document.dispatchEvent(new dom.window.Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 10));
    });
    assert.match(text(view.box), /R\$ 400,00/);
    } finally {
      await view.unmount();
    }
  } finally {
    setDaySourceForTest(null);
  }
});

test('Accounts shows unavailable instead of a fake zero when only FX is missing', async () => {
  const s = fixture();
  const card = s.accounts.find((a) => a.id === 'card')!;
  card.currency = 'BRL';
  card.pluggy!.bills!.items = [{ id: 'usd', dueDate: '2026-11-05', amountCents: 30000, currency: 'USD' }];
  s.settings = { ...s.settings, rates: {} };
  store.replaceState(s);
  const accounts = await mount(React.createElement(Accounts));
  try {
    assert.match(text(accounts.box), /Fatura indisponível/);
    assert.doesNotMatch(text(accounts.box), /R\$ 0,00/);
  } finally {
    await accounts.unmount();
  }
});
