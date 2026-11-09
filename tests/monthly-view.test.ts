import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/lib/defaults';
import { monthlyProjection } from '../src/lib/monthly';
import type { Account, State, Tx } from '../src/lib/types';

const MONTH = '2026-11-15';

function baseState(): State {
  const s = initialState('pt');
  return { ...s, settings: { ...s.settings, baseCurrency: 'BRL', rates: { USD: 5 } } };
}
function account(id: string, extra: Partial<Account> = {}): Account {
  return {
    id, name: id, icon: 'bank', color: '#3D8BFF', currency: 'BRL', initial: 0,
    includeInTotal: true, archived: false, order: 0, ...extra,
  };
}
function tx(id: string, kind: 'income' | 'expense', amount: number, date: string, accountId: string, extra: Partial<Tx> = {}): Tx {
  return { id, kind, amount, base: amount, date, accountId, categoryId: 'other_expense', note: '', tags: [], created: `${date}T12:00:00.000Z`, ...extra };
}
function cardWithBills(id: string, items: { id: string; dueDate: string; amountCents: number; currency: string }[], status: 'fresh' | 'stale' | 'error' = 'fresh'): Account {
  return account(id, {
    icon: 'cards', pluggy: { apiId: 'a', accountId: id, type: 'CREDIT', bills: { items, fetchedAt: '2026-11-09T00:00:00.000Z', status } },
  });
}

test('monthly result: bills by due date, no double counting, manual card net', () => {
  const s = baseState();
  const bank = account('bank');
  const card = cardWithBills('card', [
    { id: 'nov', dueDate: '2026-11-05', amountCents: 30000, currency: 'BRL' },
    { id: 'dec', dueDate: '2026-12-05', amountCents: 40000, currency: 'BRL' },
  ]);
  const manual = account('manual', { icon: 'cards', currency: 'BRL' });
  const state: State = {
    ...s,
    accounts: [bank, card, manual],
    txs: [
      tx('income', 'income', 500000, '2026-11-01', 'bank'),
      tx('bank-exp', 'expense', 100000, '2026-11-02', 'bank'),
      tx('old-card-buy', 'expense', 20000, '2026-10-20', 'card'),
      tx('future-installment', 'expense', 5000, '2026-12-02', 'card', { done: true }),
      tx('manual-exp', 'expense', 7000, '2026-11-10', 'manual'),
      tx('manual-refund', 'income', 1000, '2026-11-11', 'manual'),
    ],
    transfers: [{ id: 'pay', from: 'bank', to: 'card', fromAmount: 10000, toAmount: 10000, date: '2026-11-06', note: 'pay', created: '2026-11-06T12:00:00.000Z' }],
  };
  const before = JSON.stringify(state);
  const r = monthlyProjection(state, undefined, MONTH);
  assert.equal(r.income, 500000);
  assert.equal(r.expense, 100000 + 30000 + 6000);
  assert.equal(r.net, 364000);
  assert.equal(r.complete, true);
  assert.equal(r.stale, false);
  const cardRow = r.cards.find((c) => c.accountId === 'card')!;
  assert.equal(cardRow.amount, 30000);
  assert.equal(cardRow.status, 'fresh');
  assert.equal(r.cards.find((c) => c.accountId === 'manual')?.amount, 6000);
  assert.equal(JSON.stringify(state), before);
});

test('civil due dates at month boundaries and UTC midnight stay in the right month', () => {
  const s = baseState();
  const card = cardWithBills('card', [
    { id: 'feb', dueDate: '2026-02-28', amountCents: 100, currency: 'BRL' },
    { id: 'mar', dueDate: '2026-03-01T00:00:00Z', amountCents: 200, currency: 'BRL' },
    { id: 'apr', dueDate: '2026-04-01', amountCents: 400, currency: 'BRL' },
  ]);
  const state = { ...s, accounts: [card] };
  const march = monthlyProjection(state, undefined, '2026-03-15');
  assert.equal(march.expense, 200);
  const feb = monthlyProjection(state, undefined, '2026-02-15');
  assert.equal(feb.expense, 100);
  const dec = monthlyProjection({ ...state, settings: { ...state.settings } }, undefined, '2026-12-15');
  assert.equal(dec.complete, false);
});

test('missing, stale, negative and invalid bills are unavailable, never invented zero', () => {
  const s = baseState();
  const missing = account('missing', { icon: 'cards', pluggy: { apiId: 'a', accountId: 'missing', type: 'CREDIT' } });
  let state = { ...s, accounts: [missing] };
  let r = monthlyProjection(state, undefined, MONTH);
  assert.equal(r.complete, false);
  assert.equal(r.cards[0].status, 'missing');
  assert.equal(r.expense, 0);

  const stale = cardWithBills('stale', [{ id: 'nov', dueDate: '2026-11-05', amountCents: 30000, currency: 'BRL' }], 'stale');
  state = { ...s, accounts: [stale] };
  r = monthlyProjection(state, undefined, MONTH);
  assert.equal(r.cards[0].status, 'stale');
  assert.equal(r.cards[0].amount, 30000);
  assert.equal(r.complete, false);
  assert.equal(r.stale, true);

  const negative = cardWithBills('negative', [{ id: 'neg', dueDate: '2026-11-05', amountCents: -5000, currency: 'BRL' }]);
  state = { ...s, accounts: [negative] };
  r = monthlyProjection(state, undefined, MONTH);
  assert.equal(r.cards[0].status, 'negative');
  assert.equal(r.cards[0].amount, 0);
  assert.equal(r.expense, 0);
  assert.equal(r.complete, false);

  const empty = cardWithBills('empty', []);
  state = { ...s, accounts: [empty] };
  r = monthlyProjection(state, undefined, MONTH);
  assert.equal(r.cards[0].status, 'missing');
  assert.equal(r.complete, false);

  const zero = cardWithBills('zero', [{ id: 'zero', dueDate: '2026-11-05', amountCents: 0, currency: 'BRL' }]);
  state = { ...s, accounts: [zero] };
  r = monthlyProjection(state, undefined, MONTH);
  assert.equal(r.cards[0].status, 'fresh');
  assert.equal(r.expense, 0);
  assert.equal(r.complete, true);
});

test('currency conversion uses valid rates and never the fallback 1', () => {
  const s = baseState();
  const usd = cardWithBills('usd', [{ id: 'nov', dueDate: '2026-11-05', amountCents: 1000, currency: 'USD' }]);
  usd.currency = 'USD';
  let state = { ...s, accounts: [usd] };
  let r = monthlyProjection(state, undefined, MONTH);
  assert.equal(r.expense, 5000);
  assert.equal(r.complete, true);
  assert.equal(r.cards[0].amount, 1000);

  state = { ...state, settings: { ...state.settings, rates: {} } };
  r = monthlyProjection(state, undefined, MONTH);
  assert.equal(r.complete, false);
  assert.equal(r.expense, 0);

  const selected = monthlyProjection({ ...s, accounts: [usd] }, 'usd', MONTH);
  assert.equal(selected.currency, 'USD');
  assert.equal(selected.expense, 1000);
  assert.equal(selected.net, -1000);
  assert.equal(selected.complete, true, 'seleção em USD não exige conversão para base');
  assert.equal(selected.cards[0].amount, 1000);
});

test('manual card convention, BANK with cards icon, include/archived and account filter', () => {
  const s = baseState();
  const bankWithCardsIcon = account('pluggy-bank', { icon: 'cards', pluggy: { apiId: 'a', accountId: 'b', type: 'BANK' } });
  const manual = account('manual', { icon: 'cards' });
  const archivedCard = cardWithBills('archived', [{ id: 'x', dueDate: '2026-11-05', amountCents: 999, currency: 'BRL' }], 'fresh');
  archivedCard.archived = true;
  const excluded = cardWithBills('excluded', [{ id: 'y', dueDate: '2026-11-05', amountCents: 500, currency: 'BRL' }], 'fresh');
  excluded.includeInTotal = false;
  const state: State = {
    ...s,
    accounts: [bankWithCardsIcon, manual, archivedCard, excluded],
    txs: [
      tx('bank-in', 'income', 10000, '2026-11-01', 'pluggy-bank'),
      tx('bank-out', 'expense', 2000, '2026-11-02', 'pluggy-bank'),
      tx('man-exp', 'expense', 7000, '2026-11-03', 'manual'),
      tx('man-in', 'income', 1000, '2026-11-04', 'manual'),
    ],
  };
  const r = monthlyProjection(state, undefined, MONTH);
  assert.equal(r.income, 10000);
  assert.equal(r.expense, 2000 + 6000);
  assert.equal(r.cards.some((c) => c.accountId === 'archived'), false);
  assert.equal(r.cards.find((c) => c.accountId === 'excluded')?.amount, 500);
  assert.equal(r.complete, true); // excluded card is not part of the total
  const selected = monthlyProjection(state, 'excluded', MONTH);
  assert.equal(selected.currency, 'BRL');
  assert.equal(selected.expense, 500);
  assert.equal(selected.income, 0);
  const selectedManual = monthlyProjection(state, 'manual', MONTH);
  assert.equal(selectedManual.expense, 6000);
  assert.equal(selectedManual.income, 0);
  const selectedBank = monthlyProjection(state, 'pluggy-bank', MONTH);
  assert.equal(selectedBank.expense, 2000);
  assert.equal(selectedBank.income, 10000);
});

test('native amount survives missing FX; unknown conversion is never a fake zero', () => {
  const s = baseState();
  const usdCard = cardWithBills('usd', [{ id: 'nov', dueDate: '2026-11-05', amountCents: 30000, currency: 'USD' }]);
  usdCard.currency = 'USD';
  let state = { ...s, accounts: [usdCard], settings: { ...s.settings, rates: {} } };
  const selected = monthlyProjection(state, 'usd', MONTH);
  assert.equal(selected.cards[0].amount, 30000);
  assert.equal(selected.expense, 30000);
  assert.equal(selected.complete, true);

  const brlCard = cardWithBills('brl', [{ id: 'nov', dueDate: '2026-11-05', amountCents: 30000, currency: 'USD' }]);
  state = { ...state, accounts: [brlCard] };
  const total = monthlyProjection(state, undefined, MONTH);
  assert.equal(total.cards[0].amount, null);
  assert.equal(total.complete, false);
  assert.equal(total.expense, 0);
});

test('overflow after individual safe values makes the projection incomplete', () => {
  const s = baseState();
  const bank = account('bank');
  const huge = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 100;
  const state = { ...s, accounts: [bank], txs: [
    tx('a', 'income', huge, '2026-11-01', 'bank'),
    tx('b', 'income', huge, '2026-11-02', 'bank'),
  ] };
  const r = monthlyProjection(state, undefined, MONTH);
  assert.equal(r.complete, false);
  assert.equal(Number.isSafeInteger(r.income), true);
  assert.equal(Number.isSafeInteger(r.net), true);
});

test('stale known invoices stay in the partial result; refresh replaces them', () => {
  const s = baseState();
  const bank = account('bank');
  const stale = cardWithBills('card', [{ id: 'nov', dueDate: '2026-11-05', amountCents: 30000, currency: 'BRL' }], 'stale');
  const state: State = {
    ...s,
    accounts: [bank, stale],
    txs: [tx('in', 'income', 500000, '2026-11-01', 'bank'), tx('out', 'expense', 100000, '2026-11-02', 'bank')],
  };
  let r = monthlyProjection(state, undefined, MONTH);
  assert.equal(r.expense, 130000);
  assert.equal(r.net, 370000);
  assert.equal(r.complete, false);
  assert.equal(r.stale, true);
  assert.ok(r.staleAt);
  assert.equal(r.cards[0].amount, 30000);
  const selected = monthlyProjection(state, 'card', MONTH);
  assert.equal(selected.expense, 30000);
  assert.equal(selected.net, -30000);
  assert.equal(selected.complete, false);

  const fresh = { ...state, accounts: [bank, cardWithBills('card', [{ id: 'nov', dueDate: '2026-11-05', amountCents: 40000, currency: 'BRL' }])] };
  r = monthlyProjection(fresh, undefined, MONTH);
  assert.equal(r.expense, 140000);
  assert.equal(r.net, 360000);
  assert.equal(r.complete, true);
  assert.equal(r.stale, false);
});

test('bill sum overflow invalidates the quantity instead of dropping one bill', () => {
  const s = baseState();
  const safe = Number.MAX_SAFE_INTEGER;
  const card = cardWithBills('card', [
    { id: 'a', dueDate: '2026-11-05', amountCents: safe, currency: 'BRL' },
    { id: 'b', dueDate: '2026-11-06', amountCents: safe, currency: 'BRL' },
  ]);
  const state = { ...s, accounts: [card] };
  const r = monthlyProjection(state, undefined, MONTH);
  assert.equal(r.cards[0].amount, null);
  assert.equal(r.complete, false);
  assert.equal(r.expense, 0);
  const selected = monthlyProjection(state, 'card', MONTH);
  assert.equal(selected.cards[0].amount, null);
  assert.equal(selected.complete, false);
});
