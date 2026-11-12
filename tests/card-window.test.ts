import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/lib/defaults';
import { syncPluggyVia } from '../src/lib/pluggy';
import { bank, card, makeNet, testConn } from './pluggy-fake';
import type { State } from '../src/lib/types';

for (const [label, credit, saved, expected] of [
  ['CREDIT recent', true, true, '2026-09-27'],
  ['BANK recent', false, true, '2026-11-10'],
  ['CREDIT without checkpoint', true, false, '2025-11-11'],
] as const) {
  test(label, async () => {
    const net = makeNet({ 'http://a.test': { clientId: 'client-a', clientSecret: 'secret-a', items: [{ id: 'item', name: 'Banco', accounts: [{ account: credit ? card('acct', 0) : bank('acct', 0), txs: [] }] }] } });
    let state: State = { ...initialState('pt'), pluggy: [testConn('a', 'http://a.test', ['item'], saved ? { accountSync: { 'a|acct': '2026-11-11' } } : {})] };
    const result = await syncPluggyVia(() => state, (fn) => { state = fn(state); }, undefined, { now: () => Date.parse('2026-11-11T12:00:00Z'), fetchImpl: net.fetchImpl });
    assert.equal(result.errors.length, 0);
    assert.ok(net.calls.includes(`/v2/transactions?accountId=acct&dateFrom=${expected}`));
  });
}
