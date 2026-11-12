import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/lib/defaults';
import { nextCycles, openBills, openCycles, openMonthLabel } from '../src/lib/open-bill';
import type { Account, State, Tx } from '../src/lib/types';
const account = (id: string, itemId?: string): Account => ({ id, name: id, icon: 'cards', color: '', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 0, pluggy: { apiId: 'a', accountId: id, type: 'CREDIT', itemId } });
const transaction = (id: string, accountId: string, cycle: string, cents?: number, kind: Tx['kind'] = 'expense'): Tx => ({ id, accountId, kind, categoryId: '', amount: 1, base: 1, date: '2026-11-01', note: '', tags: [], created: '', pluggy: { apiId: 'a', txId: id, op: '', billForecastDate: cycle, billCents: cents } });
function state(): State {
  return { ...initialState('pt'), accounts: [account('old', 'old-item'), account('new', 'new-item'), account('legacy')], txs: [transaction('one', 'old', '2026-12', 5000), transaction('refund', 'old', '2026-12', 1000, 'income'), transaction('two', 'new', '2026-12', 200), transaction('three', 'legacy', '2026-12', 300)], pluggy: [{ id: 'a', name: 'a', clientId: '', clientSecret: '', itemIds: [], baseUrl: '', enabled: true, auto: true, lastSyncAt: '2026-11-11T12:00:00Z', lastStatus: 'error', itemUpdatedAt: { 'old-item': '2026-11-01T12:00:00Z', 'new-item': '2026-11-11T12:00:00Z' } }] };
}
test('open bill selects valid available cycles and preserves account origin', () => {
  const s = state();
  s.txs.push(transaction('invalid', 'old', '2026-13', 999), transaction('later', 'old', '2027-01', 700));
  const rows = openBills(s, undefined, '2026-11-11');
  assert.equal(rows.find((r) => r.accountId === 'old')?.native, 4000);
  assert.equal(rows.find((r) => r.accountId === 'old')?.originAt, '2026-11-01T12:00:00Z');
  assert.equal(rows.find((r) => r.accountId === 'new')?.originAt, '2026-11-11T12:00:00Z');
  assert.equal(rows.find((r) => r.accountId === 'legacy')?.originAt, undefined);
  assert.equal(rows[0].syncOk, false);
  assert.equal(rows[0].syncedAt, '2026-11-11T12:00:00Z');
  s.accounts[0].pluggy!.bills = { items: [{ id: 'b', dueDate: '2026-12-10', amountCents: 1, currency: 'BRL' }], status: 'fresh', fetchedAt: '' };
  assert.equal(openBills(s, 'old', '2026-11-11')[0].cycle, '2027-01');
});
test('open bill hides unknown, negative and overflowing sums', () => {
  const s = state();
  s.txs = [transaction('missing', 'old', '2026-12')];
  assert.equal(openBills(s, 'old', '2026-11-11')[0].status, 'error');
  s.txs = [transaction('refund', 'old', '2026-12', 1, 'income')];
  assert.equal(openBills(s, 'old', '2026-11-11')[0].status, 'negative');
  s.txs = [transaction('big', 'old', '2026-12', Number.MAX_SAFE_INTEGER), transaction('more', 'old', '2026-12', 1)];
  assert.equal(openBills(s, 'old', '2026-11-11')[0].status, 'error');
  s.txs = [];
  assert.deepEqual(openBills(s, 'old', '2026-11-11'), []);
});
test('civil month labels preserve December and January', () => {
  assert.equal(openMonthLabel('2026-12', 'pt-BR'), 'dez.');
  assert.equal(openMonthLabel('2027-01', 'pt-BR'), 'jan.');
});

test('published and linked bills are excluded; unavailable exchange is not invented', () => {
  const s = state();
  s.settings.baseCurrency = 'BRL';
  s.settings.rates = {};
  s.accounts[0].currency = 'USD';
  s.txs = [transaction('linked', 'old', '2026-11', 100), transaction('available', 'old', '2026-12', 900)];
  s.txs[0].pluggy!.billId = 'b';
  const row = openBills(s, 'old', '2026-11-11')[0];
  assert.equal(row.cycle, '2026-12');
  assert.equal(row.native, 900);
  assert.equal(row.base, null);
  s.accounts[0].archived = true;
  assert.deepEqual(openBills(s, 'old', '2026-11-11'), []);
  s.accounts[0].archived = false;
  s.accounts[0].pluggy = undefined;
  assert.deepEqual(openBills(s, 'old', '2026-11-11'), []);
});

test('open cycles list every future published cycle in order', () => {
  const s = state();
  s.txs = [transaction('c2', 'old', '2027-02', 300), transaction('c0', 'old', '2026-12', 100), transaction('c1', 'old', '2027-01', 200)];
  const rows = openCycles(s, 'old', '2026-11-11');
  assert.deepEqual(rows.map((r) => r.cycle), ['2026-12', '2027-01', '2027-02']);
  assert.deepEqual(rows.map((r) => r.native), [100, 200, 300]);
  assert.deepEqual(rows.map((r) => r.count), [1, 1, 1]);
});
test('first open cycle equals the one shown by openBills', () => {
  const s = state();
  s.txs.push(transaction('later', 'old', '2027-01', 700));
  assert.deepEqual(openCycles(s, 'old', '2026-11-11')[0], openBills(s, 'old', '2026-11-11')[0]);
});
test('open cycles leave out cycles with a published bill', () => {
  const s = state();
  s.txs = [transaction('dec', 'old', '2026-12', 100), transaction('jan', 'old', '2027-01', 200)];
  s.accounts[0].pluggy!.bills = { items: [{ id: 'b', dueDate: '2027-01-10', amountCents: 200, currency: 'BRL' }], status: 'fresh', fetchedAt: '' };
  assert.deepEqual(openCycles(s, 'old', '2026-11-11').map((r) => r.cycle), ['2026-12']);
});
test('open cycles leave out months before the current day', () => {
  const s = state();
  s.txs = [transaction('past', 'old', '2026-10', 100), transaction('now', 'old', '2026-11', 200)];
  assert.deepEqual(openCycles(s, 'old', '2026-11-11').map((r) => r.cycle), ['2026-11']);
});
test('open cycles without billCents have null native and error status', () => {
  const s = state();
  s.txs = [transaction('ok', 'old', '2026-12', 100), transaction('unknown', 'old', '2027-01')];
  const [dec, jan] = openCycles(s, 'old', '2026-11-11');
  assert.equal(dec.native, 100);
  assert.equal(jan.native, null);
  assert.equal(jan.base, null);
  assert.equal(jan.status, 'error');
});
test('open cycles subtract income from the cycle sum', () => {
  const s = state();
  s.txs = [transaction('buy', 'old', '2026-12', 500), transaction('back', 'old', '2026-12', 200, 'income')];
  assert.equal(openCycles(s, 'old', '2026-11-11')[0].native, 300);
});
test('open cycles filter by account and include every card when no account is given', () => {
  const s = state();
  s.txs = [transaction('a', 'old', '2026-12', 100), transaction('b', 'new', '2027-01', 200)];
  assert.deepEqual(openCycles(s, 'new', '2026-11-11').map((r) => r.accountId), ['new']);
  assert.deepEqual(openCycles(s, undefined, '2026-11-11').map((r) => r.accountId), ['old', 'new']);
});

test('next cycles keep published amounts apart from remaining installments', () => {
  const s = state();
  s.txs = [transaction('pub', 'old', '2026-12', 1000)];
  const plan = [1, 2].map((n) => ({ ...transaction(`p${n}`, 'old', '', 500), pluggy: { apiId: 'a', txId: `p${n}`, op: '', billId: 'bill-old', billCents: 500, installmentNumber: n, totalInstallments: 4, purchaseDate: '2026-03-05' } }));
  s.txs.push(...plan);
  s.accounts[0].pluggy!.bills = { items: [{ id: 'bill-old', dueDate: '2026-11-10', amountCents: 0, currency: 'BRL' }], status: 'fresh', fetchedAt: '' };
  const rows = nextCycles(s, 'old', '2026-11-11');
  const dec = rows.find((r) => r.cycle === '2026-12')!;
  assert.equal(dec.published?.native, 1000);
  assert.equal(dec.installments?.cents, 500);
  assert.equal(dec.installments?.count, 1);
  assert.equal(rows.find((r) => r.cycle === '2027-01')?.published, null);
});
test('a cycle with only projected installments has no published amount', () => {
  const s = state();
  s.txs = [];
  const plan = [1, 2].map((n) => ({ ...transaction(`q${n}`, 'old', '', 500), pluggy: { apiId: 'a', txId: `q${n}`, op: '', billId: 'bill-old', billCents: 500, installmentNumber: n, totalInstallments: 4, purchaseDate: '2026-03-05' } }));
  s.txs.push(...plan);
  s.accounts[0].pluggy!.bills = { items: [{ id: 'bill-old', dueDate: '2026-11-10', amountCents: 0, currency: 'BRL' }], status: 'fresh', fetchedAt: '' };
  const rows = nextCycles(s, 'old', '2026-11-11');
  const dec = rows.find((r) => r.cycle === '2026-12')!;
  assert.equal(dec.published, null);
  assert.deepEqual(dec.installments, { cents: 500, count: 1 });
});
test('an unknown published amount stays null next to projected installments', () => {
  const s = state();
  s.txs = [transaction('pub', 'old', '2026-12')];
  const plan = [1, 2].map((n) => ({ ...transaction(`u${n}`, 'old', '', 500), pluggy: { apiId: 'a', txId: `u${n}`, op: '', billId: 'bill-old', billCents: 500, installmentNumber: n, totalInstallments: 4, purchaseDate: '2026-03-05' } }));
  s.txs.push(...plan);
  s.accounts[0].pluggy!.bills = { items: [{ id: 'bill-old', dueDate: '2026-11-10', amountCents: 0, currency: 'BRL' }], status: 'fresh', fetchedAt: '' };
  const dec = nextCycles(s, 'old', '2026-11-11').find((r) => r.cycle === '2026-12')!;
  assert.equal(dec.published?.native, null);
  assert.equal(dec.installments?.cents, 500);
});

test('subscriptions stay apart from published and installment amounts', () => {
  const s = state();
  s.txs = [transaction('pub', 'old', '2026-12', 1000)];
  const series = [['2026-08', 'b8'], ['2026-09', 'b9'], ['2026-10', 'b10']] as const;
  for (const [cycle, bill] of series) {
    s.txs.push({ ...transaction(`sub-${cycle}`, 'old', cycle, 5590), note: 'NETFLIX', pluggy: { apiId: 'a', txId: `sub-${cycle}`, op: 'PAGAMENTO', billId: bill, billForecastDate: cycle, billCents: 5590 } });
  }
  s.accounts[0].pluggy!.bills = { items: [{ id: 'bill-old', dueDate: '2026-10-10', amountCents: 0, currency: 'BRL' }], status: 'fresh', fetchedAt: '' };
  const dec = nextCycles(s, 'old', '2026-11-11').find((r) => r.cycle === '2026-12')!;
  assert.equal(dec.published?.native, 1000);
  assert.equal(dec.subscriptions, undefined);
  const nov = nextCycles(s, 'old', '2026-11-11').find((r) => r.cycle === '2026-11');
  assert.deepEqual(nov?.subscriptions, { cents: 5590, count: 1 });
  assert.equal(nov?.published, null);
  assert.equal(nov?.installments, undefined);
});

test('two subscription series in the same cycle are summed, not overwritten', () => {
  const s = state();
  s.txs = [];
  const series = (note: string, cycle: string, bill: string, cents: number) => ['2026-08', '2026-09', '2026-10'].map((c, i) => ({ ...transaction(`${note}-${c}`, 'old', c, cents), note, pluggy: { apiId: 'a', txId: `${note}-${c}`, op: 'PAGAMENTO', billId: `${bill}${i}`, billForecastDate: c, billCents: cents } }));
  s.txs.push(...series('DM*Streaming Exemplo', '', 'sp', 4090), ...series('MP*EXEMPLO CLUBE', '', 'ml', 1990));
  s.accounts[0].pluggy!.bills = { items: [{ id: 'bill-old', dueDate: '2026-10-10', amountCents: 0, currency: 'BRL' }], status: 'fresh', fetchedAt: '' };
  const nov = nextCycles(s, 'old', '2026-11-12').find((r) => r.cycle === '2026-11');
  assert.deepEqual(nov?.subscriptions, { cents: 6080, count: 2 });
});
