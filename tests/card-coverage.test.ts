import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/lib/defaults';
import { syncPluggyVia } from '../src/lib/pluggy';
import { openBills } from '../src/lib/open-bill';
import { card, makeNet, testConn, tx } from './pluggy-fake';
import type { State, Tx } from '../src/lib/types';

const now = () => Date.parse('2026-11-11T12:00:00Z');
const old = Array.from({ length: 23 }, (_, i) => ({ ...tx(`old-${i}`, (i === 22 ? 9553 : 9555) / 100, '2026-10-24', { type: 'DEBIT', status: 'PENDING' }), currencyCode: 'BRL' }));
const recent = Array.from({ length: 16 }, (_, i) => ({ ...tx(`new-${i}`, (i === 15 ? 22080 : 22081) / 100, '2026-11-28', { type: 'DEBIT', status: 'PENDING' }), currencyCode: 'BRL', creditCardMetadata: { billForecastDate: '2026-12' } }));
const legacy = (id: string, amount: number): Tx => ({ id: `legacy-${id}`, kind: 'expense', accountId: 'pg-a-card', categoryId: 'food', amount, base: amount, date: '2026-10-24', note: `edited ${id}`, tags: [], created: '2026-10-24T12:00:00Z', pluggy: { apiId: 'a', txId: id, op: '' } });
async function run(complete: boolean) {
  const fetched = old.map((entry) => complete ? { ...entry, creditCardMetadata: { billForecastDate: '2026-12' } } : entry);
  const net = makeNet({ 'http://a.test': { clientId: 'client-a', clientSecret: 'secret-a', items: [{ id: 'item', name: 'Banco', accounts: [{ account: card('card', 0), txs: [...fetched, ...recent] }] }] } });
  const base = initialState('pt');
  let state: State = { ...base, accounts: [...base.accounts, { id: 'pg-a-card', name: 'Meu cartão', icon: 'cards', color: '', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 0, pluggy: { apiId: 'a', accountId: 'card', type: 'CREDIT', itemId: 'item', nameCustomized: true } }], txs: old.map((entry) => legacy(entry.id, Math.round(entry.amount * 100))), pluggy: [testConn('a', 'http://a.test', ['item'], { accountSync: { 'a|card': '2026-11-11' } })] };
  for (let i = 0; i < 2; i++) {
    const result = await syncPluggyVia(() => state, (fn) => { state = fn(state); }, undefined, { now, fetchImpl: net.fetchImpl });
    assert.equal(result.errors.length, 0);
    assert.equal(state.txs.filter((t) => t.pluggy?.apiId === 'a').length, 39);
    const first = state.txs.find((t) => t.pluggy?.txId === 'old-0')!;
    assert.equal(first.id, 'legacy-old-0');
    assert.equal(first.categoryId, 'food');
    assert.equal(first.note, 'edited old-0');
    assert.equal(first.created, '2026-10-24T12:00:00Z');
    assert.equal(state.accounts.find((a) => a.id === 'pg-a-card')?.name, 'Meu cartão');
    assert.equal(state.accounts.find((a) => a.id === 'pg-a-card')?.pluggy?.forecastGap, !complete);
    const row = openBills(state, 'pg-a-card', '2026-11-11')[0];
    assert.equal(row.cycle, '2026-12');
    assert.equal(row.status, complete ? 'open' : 'partial');
    assert.equal(row.count, complete ? 39 : 16);
    assert.equal(row.native, complete ? 573058 : 353295);
    assert.equal(first.pluggy?.billForecastDate, complete ? '2026-12' : undefined);
  }
}
test('complete re-read recovers legacy forecasts without duplicates', () => run(true));
test('incomplete re-read identifies partial coverage', () => run(false));

test('negative takes precedence over a coverage gap', () => {
  const s = initialState('pt');
  const state: State = { ...s, accounts: [{ id: 'card', name: 'Card', icon: 'cards', color: '', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 0, pluggy: { apiId: 'a', accountId: 'card', type: 'CREDIT', forecastGap: true } }], txs: [{ ...legacy('refund', 100), accountId: 'card', kind: 'income', pluggy: { apiId: 'a', txId: 'refund', op: 'ESTORNO', billForecastDate: '2026-12', billCents: 100 } }] };
  const row = openBills(state, 'card', '2026-11-11')[0];
  assert.equal(row.native, -100);
  assert.equal(row.status, 'negative');
});
test('missing monetary proof takes precedence over coverage gap', () => {
  const s = initialState('pt');
  const state: State = { ...s, accounts: [{ id: 'card', name: 'Card', icon: 'cards', color: '', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 0, pluggy: { apiId: 'a', accountId: 'card', type: 'CREDIT', forecastGap: true } }], txs: [{ ...legacy('unknown', 100), accountId: 'card', pluggy: { apiId: 'a', txId: 'unknown', op: '', billForecastDate: '2026-12' } }] };
  assert.equal(openBills(state, 'card', '2026-11-11')[0].status, 'error');
});
test('a clean subsequent response clears a previously detected gap', async () => {
  const item = { id: 'item', name: 'Banco', accounts: [{ account: card('card', 0), txs: [old[0], recent[0]] }] };
  const net = makeNet({ 'http://a.test': { clientId: 'client-a', clientSecret: 'secret-a', items: [item] } });
  let state: State = { ...initialState('pt'), pluggy: [testConn('a', 'http://a.test', ['item'])] };
  const sync = () => syncPluggyVia(() => state, (fn) => { state = fn(state); }, undefined, { now, fetchImpl: net.fetchImpl });
  assert.equal((await sync()).errors.length, 0);
  assert.equal(state.accounts.find((a) => a.pluggy?.accountId === 'card')?.pluggy?.forecastGap, true);
  item.accounts[0].txs[0] = { ...old[0], creditCardMetadata: { billForecastDate: '2026-12' } } as typeof old[0];
  assert.equal((await sync()).errors.length, 0);
  assert.equal(state.accounts.find((a) => a.pluggy?.accountId === 'card')?.pluggy?.forecastGap, false);
});
