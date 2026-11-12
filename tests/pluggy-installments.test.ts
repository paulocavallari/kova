import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/lib/defaults';
import { syncPluggyVia } from '../src/lib/pluggy';
import { card, makeNet, testConn, tx } from './pluggy-fake';
import type { State } from '../src/lib/types';

const now = () => Date.parse('2026-11-11T12:00:00Z');
const cardAccount = { id: 'pg-a-card', name: 'Meu cartão', icon: 'cards', color: '', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 0, pluggy: { apiId: 'a', accountId: 'card', type: 'CREDIT', itemId: 'item', nameCustomized: true } };
const purchase = (meta: Record<string, unknown>) => ({ ...tx('buy', 153.04, '2026-10-24', { type: 'DEBIT', status: 'POSTED' }), currencyCode: 'BRL', creditCardMetadata: { billId: 'bill-1', billForecastDate: '2026-12', ...meta } });
async function sync(meta: Record<string, unknown>, prior: State['txs'] = []): Promise<State> {
  const net = makeNet({ 'http://a.test': { clientId: 'client-a', clientSecret: 'secret-a', items: [{ id: 'item', name: 'Banco', accounts: [{ account: card('card', 0), txs: [purchase(meta)] }] }] } });
  const base = initialState('pt');
  let state: State = { ...base, accounts: [...base.accounts, cardAccount], txs: prior, pluggy: [testConn('a', 'http://a.test', ['item'])] };
  const result = await syncPluggyVia(() => state, (fn) => { state = fn(state); }, undefined, { now, fetchImpl: net.fetchImpl });
  assert.equal(result.errors.length, 0);
  return state;
}
const stored = (state: State) => state.txs.find((t) => t.pluggy?.txId === 'buy')!.pluggy as Record<string, unknown>;

test('valid installment metadata is stored on the transaction', async () => {
  const pluggy = stored(await sync({ installmentNumber: 13, totalInstallments: 21, purchaseDate: '2026-03-05' }));
  assert.equal(pluggy.installmentNumber, 13);
  assert.equal(pluggy.totalInstallments, 21);
  assert.equal(pluggy.purchaseDate, '2026-03-05');
});

test('missing installment metadata leaves the fields empty', async () => {
  const pluggy = stored(await sync({}));
  assert.equal(pluggy.installmentNumber, undefined);
  assert.equal(pluggy.totalInstallments, undefined);
  assert.equal(pluggy.purchaseDate, undefined);
});

test('installment number above the total is discarded', async () => {
  const pluggy = stored(await sync({ installmentNumber: 22, totalInstallments: 21, purchaseDate: '2026-03-05' }));
  assert.equal(pluggy.installmentNumber, undefined);
  assert.equal(pluggy.totalInstallments, undefined);
});

test('a single-installment purchase is discarded', async () => {
  const pluggy = stored(await sync({ installmentNumber: 1, totalInstallments: 1, purchaseDate: '2026-03-05' }));
  assert.equal(pluggy.installmentNumber, undefined);
  assert.equal(pluggy.totalInstallments, undefined);
});

test('non-integer, negative or malformed values are discarded', async () => {
  const fractional = stored(await sync({ installmentNumber: 1.5, totalInstallments: 21, purchaseDate: '2026-03-05' }));
  assert.equal(fractional.installmentNumber, undefined);
  const negative = stored(await sync({ installmentNumber: -2, totalInstallments: 21, purchaseDate: '2026-03-05' }));
  assert.equal(negative.installmentNumber, undefined);
  const badDate = stored(await sync({ installmentNumber: 13, totalInstallments: 21, purchaseDate: '05/03/2026' }));
  assert.equal(badDate.purchaseDate, undefined);
});

test('fields known to be unreliable are ignored even when the bank sends them', async () => {
  const pluggy = stored(await sync({ installmentNumber: 13, totalInstallments: 21, purchaseDate: '2026-03-05', totalAmount: 99999, billPostDate: '2026-11-10', paymentType: 'INSTALLMENT' }));
  assert.equal(pluggy.totalAmount, undefined);
  assert.equal(pluggy.billPostDate, undefined);
  assert.equal(pluggy.paymentType, undefined);
});

test('a later sync keeps the installment fields already stored', async () => {
  const first = await sync({ installmentNumber: 13, totalInstallments: 21, purchaseDate: '2026-03-05' });
  const second = await sync({ installmentNumber: 13, totalInstallments: 21, purchaseDate: '2026-03-05' }, first.txs);
  const pluggy = stored(second);
  assert.equal(pluggy.installmentNumber, 13);
  assert.equal(pluggy.totalInstallments, 21);
  assert.equal(second.txs.filter((t) => t.pluggy?.txId === 'buy').length, 1);
});

test('transactions saved before this change load without the new fields', async () => {
  const legacy: State['txs'] = [{ id: 'legacy-buy', kind: 'expense', accountId: 'pg-a-card', categoryId: 'food', amount: 15304, base: 15304, date: '2026-10-24', note: 'old', tags: [], created: '2026-10-24T12:00:00Z', pluggy: { apiId: 'a', txId: 'buy', op: '' } }];
  const state = await sync({}, legacy);
  const pluggy = stored(state);
  assert.equal(pluggy.installmentNumber, undefined);
  assert.equal(state.txs.find((t) => t.pluggy?.txId === 'buy')!.categoryId, 'food');
});

test('purchase date with a time component is kept as its civil day', async () => {
  const pluggy = stored(await sync({ installmentNumber: 13, totalInstallments: 21, purchaseDate: '2026-03-05T00:00:00.000Z' }));
  assert.equal(pluggy.purchaseDate, '2026-03-05');
});

test('purchase date without a time component and with an invalid calendar day is handled', async () => {
  const dateTime = stored(await sync({ installmentNumber: 13, totalInstallments: 21, purchaseDate: '2026-03-05T12:30:00' }));
  assert.equal(dateTime.purchaseDate, '2026-03-05');
  const impossible = stored(await sync({ installmentNumber: 13, totalInstallments: 21, purchaseDate: '2026-02-30' }));
  assert.equal(impossible.purchaseDate, undefined);
});
