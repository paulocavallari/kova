import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/lib/defaults';
import { likelySubscriptions, remainingInstallments } from '../src/lib/forecast';
import type { Account, PluggyBill, State, Tx } from '../src/lib/types';

const card = (id: string, bills: PluggyBill[] = []): Account => ({ id, name: id, icon: 'cards', color: '', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 0, pluggy: { apiId: 'a', accountId: id, type: 'CREDIT', bills: { items: bills, status: 'fresh', fetchedAt: '' } } });
const bill = (id: string, dueDate: string): PluggyBill => ({ id, dueDate, amountCents: 0, currency: 'BRL' });
const installment = (id: string, note: string, n: number, total: number, cents: number, extra: { billId?: string; cycle?: string; purchase?: string; kind?: Tx['kind'] } = {}): Tx => ({
  id, kind: extra.kind ?? 'expense', accountId: 'card', categoryId: '', amount: cents, base: cents, date: '2026-10-24', note, tags: [], created: '',
  pluggy: { apiId: 'a', txId: id, op: 'PAGAMENTO', billId: extra.billId, billForecastDate: extra.cycle, billCents: cents, installmentNumber: n, totalInstallments: total, purchaseDate: extra.purchase ?? '2026-03-05' },
});
function state(txs: Tx[], bills: PluggyBill[] = [], extra: Account[] = []): State {
  return { ...initialState('pt'), accounts: [card('card', bills), ...extra], txs };
}
const cyclesOf = (rows: { cycle: string }[]) => rows.map((r) => r.cycle);

test('a plan with three posted installments projects the rest after the last one', () => {
  const bills = [bill('b1', '2026-10-10'), bill('b2', '2026-11-10'), bill('b3', '2026-12-10')];
  const txs = [installment('p1', 'LOJA X', 1, 21, 10000, { billId: 'b1' }), installment('p2', 'LOJA X', 2, 21, 10000, { billId: 'b2' }), installment('p3', 'LOJA X', 3, 21, 10000, { billId: 'b3' })];
  const rows = remainingInstallments(state(txs, bills), 'card', '2026-11-11');
  assert.equal(rows.length, 18);
  assert.equal(rows[0].cycle, '2027-01');
  assert.equal(rows[17].cycle, '2028-06');
  assert.equal(rows.every((r) => r.cents === 10000 && r.count === 1), true);
});

test('a plan that already reaches its total projects nothing', () => {
  const txs = [installment('a', 'CONTINUA', 19, 21, 5000, { cycle: '2026-12' }), installment('b', 'CONTINUA', 20, 21, 5000, { cycle: '2027-01' }), installment('c', 'CONTINUA', 21, 21, 5000, { cycle: '2027-02' })];
  assert.deepEqual(remainingInstallments(state(txs), 'card', '2026-11-11'), []);
});

test('the last installment does not project a further cycle', () => {
  const txs = [installment('a', 'FINAL', 21, 21, 5000, { cycle: '2026-12' })];
  assert.deepEqual(remainingInstallments(state(txs), 'card', '2026-11-11'), []);
});

test('a PENDING installment with a truncated description joins the same plan', () => {
  const bills = [bill('b', '2026-10-10')];
  const txs = [installment('p1', 'EXEMPLO ESCOLA ALFA', 1, 21, 15304, { billId: 'b' }), installment('p2', 'EXEMPLO ESCOLA ALFA', 2, 21, 15304, { billId: 'b' }), installment('q3', 'EXEMPLO ESCOLA AL', 3, 21, 15304, { cycle: '2026-12' })];
  const rows = remainingInstallments(state(txs, bills), 'card', '2026-11-11');
  assert.equal(rows.length, 18);
  assert.equal(rows[0].cycle, '2027-01');
  assert.equal(rows.some((r) => r.cycle === '2026-11'), false);
});

test('a changed merchant prefix joins the same plan', () => {
  const bills = [bill('b', '2026-10-10')];
  const txs = [installment('a', 'CR CHICO REI', 5, 10, 8000, { billId: 'b' }), installment('b2', 'CHICO REI', 6, 10, 8000, { cycle: '2026-12' })];
  const rows = remainingInstallments(state(txs, bills), 'card', '2026-11-11');
  assert.equal(rows.some((r) => r.cycle === '2026-11'), false);
  assert.deepEqual(cyclesOf(rows), ['2027-01', '2027-02', '2027-03', '2027-04']);
});

test('same description with different purchase dates is two plans', () => {
  const bills = [bill('b', '2026-10-10')];
  const txs = [installment('a', 'LOJA', 1, 10, 1000, { billId: 'b', purchase: '2026-03-05' }), installment('b2', 'LOJA', 1, 10, 1000, { billId: 'b', purchase: '2026-06-05' })];
  const rows = remainingInstallments(state(txs, bills), 'card', '2026-11-11');
  assert.equal(rows.reduce((t, r) => t + r.cents, 0), 2 * 1000 * 9);
  assert.equal(rows.find((r) => r.cycle === '2026-11')?.count, 2);
});

test('a small rounding change in the value stays in the same plan', () => {
  const bills = [bill('b', '2026-10-10')];
  const txs = [installment('a', 'MERCADO', 1, 10, 624, { billId: 'b' }), installment('b2', 'MERCADO', 2, 10, 616, { billId: 'b' })];
  const rows = remainingInstallments(state(txs, bills), 'card', '2026-11-11');
  assert.equal(rows.length, 8);
  assert.equal(rows[0].cents, 616);
});

test('a repeated installment number ignores the plan', () => {
  const bills = [bill('b', '2026-10-10')];
  const txs = [installment('a', 'DUP', 3, 10, 1000, { billId: 'b' }), installment('b2', 'DUP', 3, 10, 1000, { billId: 'b' })];
  assert.deepEqual(remainingInstallments(state(txs, bills), 'card', '2026-11-11'), []);
});

test('without the posted bill in cache the plan is inert', () => {
  const txs = [installment('a', 'SEM FATURA', 3, 10, 1000, { billId: 'missing' })];
  assert.deepEqual(remainingInstallments(state(txs), 'card', '2026-11-11'), []);
});

test('a cycle already covered by a published bill is dropped', () => {
  const bills = [bill('b', '2026-10-10'), bill('pub', '2026-12-10')];
  const txs = [installment('a', 'LOJA', 1, 4, 1000, { billId: 'b' }), installment('b2', 'LOJA', 2, 4, 1000, { billId: 'b' })];
  assert.deepEqual(cyclesOf(remainingInstallments(state(txs, bills), 'card', '2026-11-11')), ['2026-11']);
});

test('another account does not mix into the plan', () => {
  const bills = [bill('b', '2026-10-10')];
  const txs = [installment('a', 'LOJA', 1, 4, 1000, { billId: 'b' })];
  assert.deepEqual(remainingInstallments(state(txs, bills, [card('other')]), 'other', '2026-11-11'), []);
});

test('income is ignored', () => {
  const bills = [bill('b', '2026-10-10')];
  const txs = [installment('a', 'LOJA', 1, 4, 1000, { billId: 'b', kind: 'income' })];
  assert.deepEqual(remainingInstallments(state(txs, bills), 'card', '2026-11-11'), []);
});

test('the projection crosses the year end from December to January', () => {
  const bills = [bill('b', '2026-11-10')];
  const txs = [installment('a', 'VIRADA', 1, 4, 1000, { billId: 'b' }), installment('b2', 'VIRADA', 2, 4, 1000, { billId: 'b' })];
  assert.deepEqual(cyclesOf(remainingInstallments(state(txs, bills), 'card', '2026-11-11')), ['2026-12', '2027-01']);
});

test('the ESCOLA ALFA and PRODUTOS shape closes the reference cycle of dec/26', () => {
  const bills = [bill('bg', '2026-11-10'), bill('bp', '2026-11-10')];
  const escolaAlfa = [13, 14, 15, 16].map((n) => installment(`g${n}`, 'EXEMPLO ESCOLA ALFA', n, 21, 15304, { billId: 'bg' }));
  const produtos = [installment('p17', 'MERCADOPAGO*EXEMPLO PRODUTOS', 17, 18, 4261, { billId: 'bp' })];
  const rows = remainingInstallments(state([...escolaAlfa, ...produtos], bills), 'card', '2026-11-11');
  assert.equal(rows.find((r) => r.cycle === '2026-12')?.cents, 15304 + 4261);
});

const sub = (id: string, note: string, cycle: string, cents: number, bill: string, kind: Tx['kind'] = 'expense'): Tx => ({
  id, kind, accountId: 'card', categoryId: '', amount: cents, base: cents, date: `${cycle}-05`, note, tags: [], created: '',
  pluggy: { apiId: 'a', txId: id, op: 'PAGAMENTO', billId: bill, billForecastDate: cycle, billCents: cents },
});
const months = (...cycles: string[]) => cycles.map((c) => bill(`bill-${c}`, `${c}-10`));
const subsOf = (rows: { cycle: string; cents: number; count: number }[]) => rows;

test('three consecutive identical charges predict the next cycle', () => {
  const s = state([sub('s1', 'NETFLIX', '2026-08', 5590, 'bill-2026-08'), sub('s2', 'NETFLIX', '2026-09', 5590, 'bill-2026-09'), sub('s3', 'NETFLIX', '2026-10', 5590, 'bill-2026-10')], months('2026-08', '2026-09', '2026-10'));
  assert.deepEqual(subsOf(likelySubscriptions(s, 'card', '2026-11-11')), [{ accountId: 'card', cycle: '2026-11', cents: 5590, count: 1 }]);
});

test('a changed amount in one month is not a subscription', () => {
  const s = state([sub('s1', 'NETFLIX', '2026-08', 5590, 'bill-2026-08'), sub('s2', 'NETFLIX', '2026-09', 6090, 'bill-2026-09'), sub('s3', 'NETFLIX', '2026-10', 5590, 'bill-2026-10')], months('2026-08', '2026-09', '2026-10'));
  assert.deepEqual(likelySubscriptions(s, 'card', '2026-11-11'), []);
});

test('two charges in the same month do not count as a subscription', () => {
  const s = state([sub('s1', 'NETFLIX', '2026-08', 5590, 'bill-2026-08'), sub('s2', 'NETFLIX', '2026-09', 5590, 'bill-2026-09'), sub('s3', 'NETFLIX', '2026-10', 5590, 'bill-2026-10'), sub('s4', 'NETFLIX', '2026-10', 5590, 'bill-2026-10')], months('2026-08', '2026-09', '2026-10'));
  assert.deepEqual(likelySubscriptions(s, 'card', '2026-11-11'), []);
});

test('a charge already billed in the current month is not predicted again', () => {
  const s = state([sub('s1', 'NETFLIX', '2026-09', 5590, 'bill-2026-09'), sub('s2', 'NETFLIX', '2026-10', 5590, 'bill-2026-10'), sub('s3', 'NETFLIX', '2026-11', 5590, 'bill-2026-11')], months('2026-09', '2026-10', '2026-11'));
  assert.deepEqual(cyclesOf(likelySubscriptions(s, 'card', '2026-11-11')), ['2026-12']);
});

test('a charge with installment metadata never becomes a subscription', () => {
  const parcel = (id: string, cycle: string, n: number) => ({ ...sub(id, 'EXEMPLO ALFA', cycle, 15304, `bill-${cycle}`), pluggy: { apiId: 'a', txId: id, op: 'PAGAMENTO', billId: `bill-${cycle}`, billForecastDate: cycle, billCents: 15304, installmentNumber: n, totalInstallments: 21, purchaseDate: '2026-03-05' } });
  const s = state([parcel('p1', '2026-08', 5), parcel('p2', '2026-09', 6), parcel('p3', '2026-10', 7)], months('2026-08', '2026-09', '2026-10'));
  assert.deepEqual(likelySubscriptions(s, 'card', '2026-11-11'), []);
});

test('a changed merchant prefix is one series', () => {
  const s = state([sub('s1', 'MP*ASSINATURA', '2026-08', 3990, 'bill-2026-08'), sub('s2', 'MERCADOPAGO*ASSINATURA', '2026-09', 3990, 'bill-2026-09'), sub('s3', 'MP*ASSINATURA', '2026-10', 3990, 'bill-2026-10')], months('2026-08', '2026-09', '2026-10'));
  assert.deepEqual(likelySubscriptions(s, 'card', '2026-11-11'), [{ accountId: 'card', cycle: '2026-11', cents: 3990, count: 1 }]);
});

test('income and other accounts are ignored', () => {
  const s = state([sub('s1', 'NETFLIX', '2026-08', 5590, 'bill-2026-08', 'income'), sub('s2', 'NETFLIX', '2026-09', 5590, 'bill-2026-09', 'income'), sub('s3', 'NETFLIX', '2026-10', 5590, 'bill-2026-10', 'income')], months('2026-08', '2026-09', '2026-10'));
  assert.deepEqual(likelySubscriptions(s, 'card', '2026-11-11'), []);
  assert.deepEqual(likelySubscriptions(state([], []), 'nonexistent', '2026-11-11'), []);
});

test('real merchant prefixes with a space before the asterisk form one series', () => {
  const real = (id: string, note: string, cycle: string, cents: number) => ({ ...sub(id, note, cycle, cents, `bill-${cycle}`) });
  const s = state([
    real('a1', 'DM*Streaming Exemplo', '2026-09', 4090), real('a2', 'DM          *Streaming Exemplo', '2026-10', 4090), real('a3', 'EBN*STREAMING EXEMPLO', '2026-11', 4090),
    real('m1', 'EXEMPLO CLUBE', '2026-09', 1990), real('m2', 'EXEMPLO CLUBE', '2026-10', 1990), real('m3', 'EXEMPLO CLUBE', '2026-11', 1990),
  ], months('2026-09', '2026-10', '2026-11'));
  const rows = likelySubscriptions(s, 'card', '2026-11-12');
  assert.deepEqual(rows.map((r) => [r.cents, r.cycle]).sort(), [[1990, '2026-12'], [4090, '2026-12']].sort());
});
