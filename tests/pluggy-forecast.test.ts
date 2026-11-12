import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/lib/defaults';
import { syncPluggyVia } from '../src/lib/pluggy';
import { card, makeNet, testConn, tx } from './pluggy-fake';
import type { State } from '../src/lib/types';

const now = () => Date.parse('2026-11-09T12:00:00Z');
test('billCents preserves currency proof and forecast metadata across syncs', async () => {
  const purchases = [
    { ...tx('foreign', 100, '2026-11-08', { type: 'DEBIT' }), currencyCode: 'USD', amountInAccountCurrency: 500, creditCardMetadata: { billForecastDate: '2026-12', billId: 'bill' } },
    { ...tx('unproved', 10, '2026-11-08', { type: 'DEBIT' }), currencyCode: 'USD', creditCardMetadata: { billForecastDate: '2026-12' } },
    { ...tx('same', 20, '2026-11-08', { type: 'DEBIT' }), currencyCode: 'BRL', creditCardMetadata: { billForecastDate: '2026-12' } },
    ...['2026-13', '2026-00', '2026-99'].map((date) => ({ ...tx(date, 1, '2026-11-08', { type: 'DEBIT' }), currencyCode: 'BRL', creditCardMetadata: { billForecastDate: date } })),
    tx('legacy', 3, '2026-11-08', { type: 'DEBIT' }),
  ];
  const net = makeNet({ 'http://a.test': { clientId: 'client-a', clientSecret: 'secret-a', items: [
    { id: 'old-item', name: 'Old', accounts: [{ account: card('c1', 0), txs: purchases }] },
    { id: 'new-item', name: 'New', accounts: [{ account: card('c2', 0), txs: [] }] },
  ] } });
  let s: State = { ...initialState('pt'), pluggy: [testConn('a', 'http://a.test', ['old-item', 'new-item'])] };
  for (let i = 0; i < 3; i++) {
    const result = await syncPluggyVia(() => s, (fn) => { s = fn(s); }, undefined, { now, fetchImpl: net.fetchImpl });
    assert.equal(result.errors.length, 0);
    assert.equal(s.txs.length, purchases.length);
    const find = (id: string) => s.txs.find((t) => t.pluggy?.txId === id)!;
    assert.equal(find('foreign').amount, 10000);
    assert.equal(find('foreign').pluggy?.billCents, 50000);
    assert.equal(find('foreign').pluggy?.billId, 'bill');
    assert.equal(find('foreign').pluggy?.billForecastDate, '2026-12');
    assert.equal(find('unproved').pluggy?.billCents, undefined);
    assert.equal(find('same').pluggy?.billCents, 2000);
    for (const date of ['2026-13', '2026-00', '2026-99']) assert.equal(find(date).pluggy?.billForecastDate, undefined);
    assert.equal(find('legacy').pluggy?.billCents, undefined);
    assert.equal(s.accounts.find((a) => a.pluggy?.accountId === 'c1')?.pluggy?.itemId, 'old-item');
    assert.equal(s.accounts.find((a) => a.pluggy?.accountId === 'c2')?.pluggy?.itemId, 'new-item');
    assert.equal(s.accounts.find((a) => a.pluggy?.accountId === 'c1')?.name, 'Cartão');
    assert.equal(s.accounts.find((a) => a.pluggy?.accountId === 'c1')?.pluggy?.lastAutoName, 'Cartão');
    if (i === 0) s = { ...s, accounts: s.accounts.map((a) => a.pluggy?.accountId === 'c1' ? { ...a, pluggy: { ...a.pluggy!, itemId: undefined } } : a) };
  }
});

test('account item association is stable by value and preserves customized names', async () => {
  const net = makeNet({ 'http://a.test': { clientId: 'client-a', clientSecret: 'secret-a', items: [
    { id: 'own-item', name: 'Banco', accounts: [{ account: card('card', 0), txs: [] }] },
    { id: 'other-item', name: 'Outro', accounts: [{ account: card('other', 0), txs: [] }] },
  ] } });
  let s: State = { ...initialState('pt'), pluggy: [testConn('a', 'http://a.test', ['own-item', 'other-item'])] };
  let clock = now();
  async function sync() {
    const result = await syncPluggyVia(() => s, (fn) => { s = fn(s); }, undefined, { now: () => clock, fetchImpl: net.fetchImpl });
    assert.equal(result.errors.length, 0);
  }
  await sync();
  s = { ...s, accounts: s.accounts.map((a) => a.pluggy?.accountId === 'card'
    ? { ...a, name: 'Meu cartão', pluggy: { ...a.pluggy!, itemId: undefined, nameCustomized: true } }
    : a) };
  await sync();
  const first = s.accounts.find((a) => a.pluggy?.accountId === 'card')!;
  assert.equal(first.name, 'Meu cartão');
  assert.equal(first.pluggy?.nameCustomized, true);
  assert.equal(first.pluggy?.itemId, 'own-item');
  const count = s.accounts.filter((a) => a.pluggy?.accountId === 'card').length;
  assert.equal(count, 1);
  function stable(account: typeof first) {
    const { initial: _initial, pluggy, ...rest } = account;
    const { bills: _bills, ...metadata } = pluggy!;
    return { ...rest, pluggy: metadata };
  }
  clock += 3600_000;
  await sync();
  const second = s.accounts.find((a) => a.pluggy?.accountId === 'card')!;
  assert.equal(second.id, first.id);
  assert.equal(second.pluggy?.itemId, 'own-item');
  assert.equal(s.accounts.filter((a) => a.pluggy?.accountId === 'card').length, count);
  assert.deepStrictEqual(stable(second), stable(first));
  assert.throws(() => assert.deepStrictEqual(stable({ ...second, name: 'Alterado' }), stable(first)));
  assert.throws(() => assert.deepStrictEqual(stable({ ...second, pluggy: { ...second.pluggy!, itemId: 'other-item' } }), stable(first)));
});
