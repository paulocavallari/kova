import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/lib/defaults';
import { balances, filterTx, sum } from '../src/lib/calc';
import type { PluggyConn, State, Tx } from '../src/lib/types';
import { autoSyncPluggyVia, DAY_MS, itemStamp, startPluggyAutoSync, syncPluggyVia, type SyncOptions } from '../src/lib/pluggy';
import { bank, card, makeNet, testConn, tx, type FakeApi } from './pluggy-fake';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const now = () => NOW;
const month = { start: '2026-11-01', end: '2026-11-30' };
const iso = (ms: number) => new Date(ms).toISOString();

function mkState(conns: PluggyConn[], extra: Partial<State> = {}): State {
  const s = initialState('pt');
  return { ...s, pluggy: conns, settings: { ...s.settings, baseCurrency: 'BRL', rates: { USD: 5 }, ...extra.settings }, ...extra };
}

function api(id: string, items: FakeApi['items']): FakeApi {
  return { clientId: `client-${id}`, clientSecret: `secret-${id}`, items };
}

function conn(id: string, baseUrl: string, itemIds: string[], extra: Partial<PluggyConn> = {}): PluggyConn {
  return testConn(id, baseUrl, itemIds, extra) as PluggyConn;
}

async function runAll(s: State, opts: SyncOptions = {}) {
  let current = s;
  const result = await syncPluggyVia(() => current, (fn) => { current = fn(current); }, undefined, opts);
  return { state: current, result };
}

async function runOne(s: State, id: string, opts: SyncOptions = {}) {
  let current = s;
  const result = await syncPluggyVia(() => current, (fn) => { current = fn(current); }, id, opts);
  return { state: current, result };
}

async function auto(s: State, opts: SyncOptions = {}) {
  let current = s;
  const result = await autoSyncPluggyVia(() => current, (fn) => { current = fn(current); }, opts);
  return { state: current, changed: result.changed };
}

const bank1 = () => ({
  account: bank('bank1', 950),
  txs: [
    tx('t-pay', -100, '2026-11-05', { type: 'DEBIT', description: 'PAGTO FATURA CARTAO', operationType: 'PAGAMENTO_FATURA' }),
    tx('t-energy', -30, '2026-11-06', { type: 'DEBIT', description: 'Fatura de energia', operationType: 'PAGAMENTO' }),
    tx('t-salary', 500, '2026-11-01', { type: 'CREDIT', description: 'Salario' }),
  ],
});

const cardItem = (withPayment: boolean) => ({
  id: 'ib',
  name: 'Banco B',
  accounts: [{
    account: card('card1', 0),
    txs: withPayment
      ? [
          tx('t-buy', 100, '2026-11-04', { type: 'DEBIT', description: 'Compra Loja' }),
          tx('t-pay2', -100, '2026-11-05', { description: 'Pagamento fatura', operationType: 'PAGAMENTO_FATURA' }),
        ]
      : [tx('t-buy', 100, '2026-11-04', { type: 'DEBIT', description: 'Compra Loja' })],
  }],
});

test('card bill: purchase + payment never double-count, with destination', async () => {
  const net = makeNet({
    'http://a.test': api('a', [{ id: 'ia', name: 'Banco A', lastUpdatedAt: '2026-11-08T10:00:00.000Z', accounts: [bank1()] }]),
    'http://b.test': api('b', [cardItem(true)]),
  });
  let s = mkState([conn('a', 'http://a.test', ['ia']), conn('b', 'http://b.test', ['ib'])]);
  for (let i = 1; i <= 3; i++) {
    const run = await runAll(s, { now, fetchImpl: net.fetchImpl });
    s = run.state;
    assert.equal(run.result.errors.length, 0);
    assert.equal(sum(filterTx(s, month, 'expense')), 13000);
    assert.equal(s.transfers.filter((t) => t.pluggy).length, 1);
    const bal = balances(s);
    assert.equal(bal.get('pg-a-bank1'), 95000, `BANK exato no sync ${i}`);
    assert.equal(bal.get('pg-b-card1'), 0, `CREDIT exato no sync ${i}`);
  }
  const tr = s.transfers.find((t) => t.pluggy)!;
  assert.equal(tr.from, 'pg-a-bank1');
  assert.equal(tr.to, 'pg-b-card1');
  assert.equal(tr.fromAmount, 10000);
  assert.equal(tr.pluggy?.kind, 'card');
  assert.equal(s.txs.filter((t) => t.pluggy).length, 3);
  assert.equal(s.transfers.some((t) => t.from === '__adjust__' || t.to === '__adjust__'), false);
  assert.equal(s.accounts.filter((a) => a.pluggy).length, 2);
});

test('card bill: payment is dropped when no CREDIT destination leg is known', async () => {
  const net = makeNet({
    'http://a.test': api('a', [{ id: 'ia', name: 'Banco A', accounts: [bank1()] }]),
    'http://b.test': api('b', [cardItem(false)]),
  });
  let s = mkState([conn('a', 'http://a.test', ['ia']), conn('b', 'http://b.test', ['ib'])]);
  for (let i = 1; i <= 3; i++) {
    s = (await runAll(s, { now, fetchImpl: net.fetchImpl })).state;
    assert.equal(sum(filterTx(s, month, 'expense')), 13000, `despesa no sync ${i}`);
    assert.equal(s.transfers.filter((t) => t.pluggy).length, 0);
    assert.equal(balances(s).get('pg-a-bank1'), 95000, `BANK exato no sync ${i}`);
    assert.equal(balances(s).get('pg-b-card1'), 0, `CREDIT exato no sync ${i}`);
  }
  assert.equal(s.transfers.some((t) => t.from === '__adjust__' || t.to === '__adjust__'), false);
});

test('PIX across APIs becomes one Transfer, including a late leg synced alone', async () => {
  const apiA = api('a', [{
    id: 'ia', name: 'Banco A', accounts: [{ account: bank('acct-a', 1000), txs: [tx('pix-out', -250, '2026-11-03', { type: 'DEBIT', operationType: 'PIX', description: 'PIX enviado' })] }],
  }]);
  const apiB = api('b', [{
    id: 'ib', name: 'Banco B', accounts: [{ account: bank('acct-b', 500), txs: [tx('pix-in', 250, '2026-11-04', { type: 'CREDIT', operationType: 'PIX', description: 'PIX recebido' })] }],
  }]);
  const net = makeNet({ 'http://a.test': apiA, 'http://b.test': apiB });
  let s = mkState([conn('a', 'http://a.test', ['ia'])]);
  s = (await runAll(s, { now, fetchImpl: net.fetchImpl })).state;
  assert.equal(sum(filterTx(s, month, 'expense')), 25000);
  assert.equal(balances(s).get('pg-a-acct-a'), 100000);
  assert.equal(s.transfers.filter((t) => t.pluggy).length, 0);

  s = { ...s, pluggy: [...(s.pluggy ?? []), conn('b', 'http://b.test', ['ib'])] };
  s = (await runOne(s, 'b', { now, fetchImpl: net.fetchImpl })).state;
  assert.equal(sum(filterTx(s, month, 'expense')), 0);
  assert.equal(sum(filterTx(s, month, 'income')), 0);
  assert.equal(s.transfers.filter((t) => t.pluggy).length, 1);
  const pix = s.transfers.find((t) => t.pluggy)!;
  assert.equal(pix.from, 'pg-a-acct-a');
  assert.equal(pix.to, 'pg-b-acct-b');
  assert.equal(pix.pluggy?.kind, 'regular');
  assert.equal(balances(s).get('pg-a-acct-a'), 100000, 'BANK reconciliado após a ponta tardia');
  assert.equal(balances(s).get('pg-b-acct-b'), 50000);
});

test('refund, investment, currency and categorization', async () => {
  const apiA = api('a', [
    {
      id: 'i1', name: 'Banco A', accounts: [{
        account: bank('acct-a', 0),
        txs: [
          tx('app', -10, '2026-11-02', { type: 'DEBIT', operationType: 'APLICACAO', description: 'Aplicacao CDB' }),
          tx('pad', -15, '2026-11-07', { type: 'DEBIT', description: 'Padaria' }),
        ],
      }],
    },
    {
      id: 'i2', name: 'Invest', accounts: [{
        account: bank('acct-inv', 0),
        txs: [tx('res', 10, '2026-11-03', { type: 'CREDIT', operationType: 'RESGATE', description: 'Resgate CDB' })],
      }],
    },
  ]);
  const apiB = api('b', [
    {
      id: 'i3', name: 'Cartao', accounts: [{
        account: card('acct-card', 0),
        txs: [
          tx('refund', 50, '2026-11-04', { operationType: 'ESTORNO', description: 'Estorno compra' }),
          tx('openai', 20, '2026-11-05', { type: 'DEBIT', description: 'OPENAI CHATGPT' }),
        ],
      }],
    },
    {
      id: 'i4', name: 'Dolar', accounts: [{
        account: bank('acct-usd', 0, 'USD'),
        txs: [tx('usd', 1, '2026-11-06', { type: 'DEBIT', description: 'Loja EUA' })],
      }],
    },
  ]);
  const net = makeNet({ 'http://a.test': apiA, 'http://b.test': apiB });
  const s0 = mkState([conn('a', 'http://a.test', ['i1', 'i2']), conn('b', 'http://b.test', ['i3', 'i4'])]);
  const learned: NonNullable<State['merchants']> = { 'expense|padaria': { cat: 'food', note: '', acc: '', n: 1, name: 'Padaria' } };
  const s = (await runAll({ ...s0, merchants: learned }, { now, fetchImpl: net.fetchImpl })).state;

  const refund = s.txs.find((t) => t.note === 'Estorno compra')!;
  assert.equal(refund.kind, 'income');
  assert.equal(refund.amount, 5000);
  assert.equal(s.txs.find((t) => t.note === 'OPENAI CHATGPT')?.categoryId, 'shopping');
  assert.equal(s.txs.find((t) => t.note === 'Padaria')?.categoryId, 'food');
  const usd = s.txs.find((t) => t.note === 'Loja EUA')!;
  assert.equal(usd.base, 500);
  assert.equal(usd.amount, 100);
  const inv = s.transfers.find((t) => t.pluggy?.kind === 'invest');
  assert.ok(inv);
  assert.equal(inv?.fromAmount, 1000);
  assert.equal(sum(filterTx(s, month, 'expense').filter((t) => t.amount === 1000)), 0);
});

test('deterministic pairing order for equal amounts and dates', async () => {
  const apiA = api('a', [{
    id: 'ia', name: 'Banco A', accounts: [
      { account: bank('a1', 0), txs: [tx('o1', -7, '2026-11-02', { type: 'DEBIT', operationType: 'PIX', description: 'PIX 1' })] },
      { account: bank('a2', 0), txs: [tx('o2', -7, '2026-11-02', { type: 'DEBIT', operationType: 'PIX', description: 'PIX 2' })] },
    ],
  }]);
  const apiB = api('b', [{
    id: 'ib', name: 'Banco B', accounts: [
      { account: bank('b1', 0), txs: [tx('i1', 7, '2026-11-02', { type: 'CREDIT', operationType: 'PIX', description: 'PIX 1' })] },
      { account: bank('b2', 0), txs: [tx('i2', 7, '2026-11-02', { type: 'CREDIT', operationType: 'PIX', description: 'PIX 2' })] },
    ],
  }]);
  const net = makeNet({ 'http://a.test': apiA, 'http://b.test': apiB });
  let s = mkState([conn('a', 'http://a.test', ['ia']), conn('b', 'http://b.test', ['ib'])]);
  s = (await runAll(s, { now, fetchImpl: net.fetchImpl })).state;
  const ids = s.transfers.filter((t) => t.pluggy).map((t) => t.id).sort();
  assert.equal(ids.length, 2);
  s = (await runAll(s, { now, fetchImpl: net.fetchImpl })).state;
  assert.deepEqual(s.transfers.filter((t) => t.pluggy).map((t) => t.id).sort(), ids);
});

test('partial failure does not apply the failing account nor advance its checkpoint', async () => {
  const net = makeNet({
    'http://a.test': api('a', [{
      id: 'ia', name: 'Banco A', accounts: [
        bank1(),
        { account: bank('bank2', 10), txs: [tx('x', -1, '2026-11-04', { type: 'DEBIT', description: 'Loja' })], failStatus: 500 },
      ],
    }]),
  });
  const { state, result } = await runAll(mkState([conn('a', 'http://a.test', ['ia'])]), { now, fetchImpl: net.fetchImpl });
  assert.equal(result.ok, false);
  const c = state.pluggy![0];
  assert.equal(c.lastStatus, 'error');
  assert.equal(c.lastSyncAt, undefined);
  assert.equal((c.accountSync ?? {})['a|bank2'], undefined);
  assert.equal((c.accountSync ?? {})['a|bank1'], '2026-11-09');
  assert.equal(state.accounts.some((a) => a.pluggy?.accountId === 'bank2'), false);
  assert.equal(state.accounts.some((a) => a.pluggy?.accountId === 'bank1'), true);
  assert.ok(!String(c.lastError).includes('secret-a'));
});

test('two items keep both checkpoints and the next sync is incremental', async () => {
  const net = makeNet({
    'http://a.test': api('a', [{
      id: 'i1', name: 'Banco 1', accounts: [{ account: bank('b1', 100), txs: [tx('t1', -10, '2026-11-05', { type: 'DEBIT', description: 'Loja' })] }],
    }, {
      id: 'i2', name: 'Banco 2', accounts: [{ account: bank('b2', 200), txs: [tx('t2', -20, '2026-11-05', { type: 'DEBIT', description: 'Loja' })] }],
    }]),
  });
  const first = await runAll(mkState([conn('a', 'http://a.test', ['i1', 'i2'])]), { now, fetchImpl: net.fetchImpl });
  assert.deepEqual(first.state.pluggy![0].accountSync, { 'a|b1': '2026-11-09', 'a|b2': '2026-11-09' });
  net.calls.length = 0;
  const second = await runAll(first.state, { now, fetchImpl: net.fetchImpl });
  assert.ok(net.calls.includes('/v2/transactions?accountId=b1&dateFrom=2026-11-08'));
  assert.ok(net.calls.includes('/v2/transactions?accountId=b2&dateFrom=2026-11-08'));
  assert.deepEqual(second.state.pluggy![0].accountSync, { 'a|b1': '2026-11-09', 'a|b2': '2026-11-09' });
});

// ---------- automatic 24h / new data ----------
const STAMP = '2026-11-08T10:00:00.000Z';

function autoSetup(connExtra: Partial<PluggyConn> = {}, itemExtra: Record<string, unknown> = {}) {
  const net = makeNet({
    'http://a.test': api('a', [{ id: 'ia', name: 'Banco A', lastUpdatedAt: STAMP, accounts: [bank1()], ...itemExtra }]),
  });
  const state = mkState([conn('a', 'http://a.test', ['ia'], connExtra)]);
  return { net, state };
}

test('auto sync: full sync when never synced or exactly 24h old', async () => {
  {
    const { net, state } = autoSetup();
    const r = await auto(state, { now, fetchImpl: net.fetchImpl });
    assert.equal(r.changed, true);
    assert.ok(r.state.pluggy![0].lastSyncAt);
    assert.ok(net.calls.includes('/v2/transactions?accountId=bank1&dateFrom=2025-11-09'));
  }
  {
    const { net, state } = autoSetup({ lastSyncAt: iso(NOW - DAY_MS), itemUpdatedAt: { ia: STAMP } });
    net.calls.length = 0;
    const r = await auto(state, { now, fetchImpl: net.fetchImpl });
    assert.equal(r.changed, true);
    assert.ok(net.calls.some((c) => c.startsWith('/v2/transactions')));
  }
});

test('auto sync: light probe respects timestamps and the 15 min cooldown', async () => {
  {
    const { net, state } = autoSetup({ lastSyncAt: iso(NOW - 3600_000), itemUpdatedAt: { ia: STAMP } });
    const r = await auto(state, { now, fetchImpl: net.fetchImpl });
    assert.equal(r.changed, true);
    assert.ok(net.calls.includes('/items/ia'));
    assert.equal(net.calls.some((c) => c.startsWith('/v2/transactions')), false);
    assert.equal(r.state.pluggy![0].lastProbeAt, iso(NOW));
  }
  {
    const { net, state } = autoSetup({ lastSyncAt: iso(NOW - 3600_000), itemUpdatedAt: { ia: '2026-11-07T10:00:00.000Z' } });
    const r = await auto(state, { now, fetchImpl: net.fetchImpl });
    assert.ok(net.calls.some((c) => c.startsWith('/v2/transactions')));
    assert.ok(r.state.pluggy![0].lastSyncAt);
  }
  {
    const { net, state } = autoSetup({ lastSyncAt: iso(NOW - 3600_000), itemUpdatedAt: { ia: STAMP } }, { lastUpdatedAt: 'not-a-date' });
    net.calls.length = 0;
    const r = await auto(state, { now, fetchImpl: net.fetchImpl });
    assert.ok(r.state.pluggy![0].lastProbeAt);
    assert.equal(net.calls.some((c) => c.startsWith('/v2/transactions')), false);
  }
  {
    const { net, state } = autoSetup({ lastSyncAt: iso(NOW - 3600_000), lastProbeAt: iso(NOW - 5 * 60_000), itemUpdatedAt: { ia: STAMP } });
    const r = await auto(state, { now, fetchImpl: net.fetchImpl });
    assert.equal(r.changed, false);
    assert.equal(net.calls.length, 0);
  }
});

test('auto sync: disabled/off connections make no calls', async () => {
  {
    const { net, state } = autoSetup({ auto: false });
    const r = await auto(state, { now, fetchImpl: net.fetchImpl });
    assert.equal(r.changed, false);
    assert.equal(net.calls.length, 0);
  }
  {
    const { net, state } = autoSetup({ enabled: false });
    const r = await auto(state, { now, fetchImpl: net.fetchImpl });
    assert.equal(r.changed, false);
    assert.equal(net.calls.length, 0);
  }
});

test('auto sync: failure on a due connection respects the 15 min cooldown and keeps lastSyncAt', async () => {
  const net = makeNet({
    'http://a.test': { clientId: 'client-a', clientSecret: 'secret-a', items: [{ id: 'ia', name: 'Banco A', accounts: [bank1()] }] },
  });
  const bad = { ...conn('a', 'http://a.test', ['ia']), clientSecret: 'wrong-secret' };
  const first = await auto(mkState([bad]), { now, fetchImpl: net.fetchImpl });
  assert.equal(first.changed, true);
  assert.equal(first.state.pluggy![0].lastStatus, 'error');
  assert.equal(first.state.pluggy![0].lastSyncAt, undefined);
  assert.equal(first.state.pluggy![0].lastProbeAt, iso(NOW));
  assert.ok(!String(first.state.pluggy![0].lastError).includes('wrong-secret'));
  const auths = net.calls.filter((c) => c === '/auth').length;
  assert.equal(auths, 1);

  const same = await auto(first.state, { now, fetchImpl: net.fetchImpl });
  assert.equal(same.changed, false);
  const ten = await auto(first.state, { now: () => NOW + 10 * 60_000, fetchImpl: net.fetchImpl });
  assert.equal(ten.changed, false);
  assert.equal(net.calls.filter((c) => c === '/auth').length, 1);

  await auto(first.state, { now: () => NOW + 16 * 60_000, fetchImpl: net.fetchImpl });
  assert.equal(net.calls.filter((c) => c === '/auth').length, 2);
});

test('auto sync: probe failure on a recent connection keeps lastSyncAt and records status', async () => {
  const { net, state } = autoSetup({ lastSyncAt: iso(NOW - 3600_000), itemUpdatedAt: { ia: STAMP } }, { failStatus: 500 });
  const r = await auto(state, { now, fetchImpl: net.fetchImpl });
  assert.equal(r.changed, true);
  const c = r.state.pluggy![0];
  assert.equal(c.lastSyncAt, iso(NOW - 3600_000));
  assert.equal(c.lastProbeAt, iso(NOW));
  assert.equal(c.lastStatus, 'error');
  assert.ok(!String(c.lastError).includes('secret-a'));
});

test('auto sync: invalid primary timestamp falls back to updatedAt', async () => {
  assert.equal(itemStamp({ id: 'x', lastUpdatedAt: 'bad', updatedAt: STAMP }), STAMP);
  assert.equal(itemStamp({ id: 'x', lastUpdatedAt: STAMP, updatedAt: 'bad' }), STAMP);
  assert.equal(itemStamp({ id: 'x', lastUpdatedAt: 'bad', updatedAt: 'also-bad' }), undefined);
  const { net, state } = autoSetup(
    { lastSyncAt: iso(NOW - 3600_000), itemUpdatedAt: { ia: '2026-11-07T10:00:00.000Z' } },
    { lastUpdatedAt: 'bad', updatedAt: STAMP },
  );
  const r = await auto(state, { now, fetchImpl: net.fetchImpl });
  assert.ok(net.calls.some((c) => c.startsWith('/v2/transactions')));
  assert.equal(r.state.pluggy![0].itemUpdatedAt?.ia, STAMP);
});

test('auto sync: multiple items and APIs, newer item triggers the full sync', async () => {
  const net = makeNet({
    'http://a.test': api('a', [{
      id: 'ia', name: 'Banco A', lastUpdatedAt: STAMP, accounts: [bank1()],
    }, {
      id: 'ib', name: 'Banco B', lastUpdatedAt: '2026-11-09T09:00:00.000Z', accounts: [{ account: bank('bank2', 10), txs: [] }],
    }]),
    'http://b.test': api('b', [{ id: 'ic', name: 'Banco C', lastUpdatedAt: STAMP, accounts: [{ account: bank('bank3', 10), txs: [] }] }]),
  });
  const s = mkState([
    conn('a', 'http://a.test', ['ia', 'ib'], { lastSyncAt: iso(NOW - 3600_000), itemUpdatedAt: { ia: STAMP, ib: '2026-11-08T00:00:00.000Z' } }),
    conn('b', 'http://b.test', ['ic'], { lastSyncAt: iso(NOW - 3600_000), itemUpdatedAt: { ic: STAMP } }),
  ]);
  const r = await auto(s, { now, fetchImpl: net.fetchImpl });
  assert.ok(net.calls.some((c) => c.startsWith('/v2/transactions?accountId=bank2')));
  assert.equal(r.state.pluggy!.find((c) => c.id === 'b')?.lastSyncAt, iso(NOW - 3600_000));
});

test('auto sync timer replaces itself instead of duplicating', async () => {
  const { net, state } = autoSetup({ lastSyncAt: iso(NOW), itemUpdatedAt: { ia: STAMP } });
  let current = state;
  const apply = (fn: (s: State) => State) => { current = fn(current); };
  const stop1 = startPluggyAutoSync(() => current, apply, { now, fetchImpl: net.fetchImpl, intervalMs: 30 });
  const stop2 = startPluggyAutoSync(() => current, apply, { now, fetchImpl: net.fetchImpl, intervalMs: 30 });
  await new Promise((r) => setTimeout(r, 45));
  stop2();
  const after = net.calls.length;
  assert.equal(after, 2); // one auth + one item probe from a single tick
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(net.calls.length, after);
  stop1();
});

// ---------- atomic application (#1) and isolation (#4) ----------
test('local edits and connection deletion during fetch are preserved', async () => {
  let current = mkState([conn('a', 'http://a.test', ['ia']), conn('b', 'http://b.test', ['ib'])]);
  const manual: Tx = { id: 'manual-1', kind: 'expense', accountId: 'wallet', categoryId: 'food', amount: 700, base: 700, date: '2026-11-08', note: 'Manual', tags: [], created: '2026-11-08T10:00:00.000Z' };
  const net = makeNet({
    'http://a.test': api('a', [{ id: 'ia', name: 'Banco A', accounts: [bank1()] }]),
    'http://b.test': api('b', [cardItem(true)]),
  }, {
    onAuth: () => {
      current = {
        ...current,
        settings: { ...current.settings, name: 'Editado durante o fetch' },
        txs: [...current.txs, manual],
        pluggy: (current.pluggy ?? []).filter((c) => c.id !== 'b'),
      };
    },
  });
  const apply = (fn: (s: State) => State) => { current = fn(current); };
  await syncPluggyVia(() => current, apply, 'a', { now, fetchImpl: net.fetchImpl });
  assert.equal(current.settings.name, 'Editado durante o fetch');
  assert.ok(current.txs.some((t) => t.id === 'manual-1'));
  assert.equal(current.pluggy?.some((c) => c.id === 'b'), false);
  assert.ok(current.accounts.some((a) => a.pluggy?.apiId === 'a'));
});

test('queued syncs of independent APIs both survive in the final store', async () => {
  let current = mkState([conn('a', 'http://a.test', ['ia']), conn('b', 'http://b.test', ['ib'])]);
  const net = makeNet({
    'http://a.test': api('a', [{ id: 'ia', name: 'Banco A', accounts: [bank1()] }]),
    'http://b.test': api('b', [cardItem(true)]),
  });
  const apply = (fn: (s: State) => State) => { current = fn(current); };
  const results = await Promise.all([
    syncPluggyVia(() => current, apply, 'a', { now, fetchImpl: net.fetchImpl }),
    syncPluggyVia(() => current, apply, 'b', { now, fetchImpl: net.fetchImpl }),
  ]);
  assert.equal(results.every((r) => r.ok), true);
  const apiIds = current.accounts.filter((a) => a.pluggy).map((a) => a.pluggy!.apiId).sort();
  assert.deepEqual(apiIds, ['a', 'b']);
  assert.equal(current.txs.filter((t) => t.pluggy).length, 3);
  assert.equal(net.maxConcurrent, 1);
});

test('invalid base URL is isolated per connection in manual and automatic sync', async () => {
  const net = makeNet({
    'http://b.test': api('b', [{ id: 'ib', name: 'Banco B', accounts: [{ account: bank('b1', 10), txs: [] }] }]),
  });
  const bad = conn('a', 'ftp://nope', ['ia']);
  const good = conn('b', 'http://b.test', ['ib']);
  const manual = await runAll(mkState([bad, good]), { now, fetchImpl: net.fetchImpl });
  assert.equal(manual.result.ok, false);
  assert.equal(manual.state.pluggy!.find((c) => c.id === 'a')?.lastStatus, 'error');
  assert.equal(manual.state.accounts.some((a) => a.pluggy?.apiId === 'b'), true);

  net.calls.length = 0;
  const automatic = await auto(mkState([bad, good]), { now, fetchImpl: net.fetchImpl });
  assert.equal(automatic.changed, true);
  assert.equal(automatic.state.pluggy!.find((c) => c.id === 'a')?.lastStatus, 'error');
  assert.equal(automatic.state.accounts.some((a) => a.pluggy?.apiId === 'b'), true);
});

test('manual sync discards the collection when the source configuration changes during fetch', async () => {
  let current = mkState([conn('a', 'http://a.test', ['ia'])]);
  const net = makeNet({
    'http://a.test': api('a', [{ id: 'ia', name: 'Banco A', accounts: [bank1()] }]),
  }, {
    onAuth: () => {
      const old = current.pluggy![0];
      current = {
        ...current,
        pluggy: [{ ...old, clientId: 'client-new', clientSecret: 'secret-new', baseUrl: 'http://new.test', itemIds: ['ia', 'ib'] }],
      };
    },
  });
  const apply = (fn: (s: State) => State) => { current = fn(current); };
  const r = await syncPluggyVia(() => current, apply, 'a', { now, fetchImpl: net.fetchImpl });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('configuration changed')));
  const c = current.pluggy![0];
  assert.equal(c.clientId, 'client-new');
  assert.equal(c.clientSecret, 'secret-new');
  assert.equal(c.baseUrl, 'http://new.test');
  assert.deepEqual(c.itemIds, ['ia', 'ib']);
  assert.equal(current.accounts.filter((a) => a.pluggy).length, 0);
  assert.equal(current.txs.length, 0);
  assert.equal(c.lastSyncAt, undefined);
  assert.equal(c.lastStatus, undefined);
  assert.equal(c.itemUpdatedAt, undefined);
});

test('automatic sync discards stale collection and probe status when configuration changes', async () => {
  // full sync by age
  let current = mkState([conn('a', 'http://a.test', ['ia'], { lastSyncAt: iso(NOW - 2 * DAY_MS) })]);
  const net = makeNet({
    'http://a.test': api('a', [{ id: 'ia', name: 'Banco A', accounts: [bank1()] }]),
  }, {
    onAuth: () => {
      const old = current.pluggy![0];
      current = { ...current, pluggy: [{ ...old, clientId: 'new-client', clientSecret: 'new-secret', baseUrl: 'http://new.test' }] };
    },
  });
  const apply = (fn: (s: State) => State) => { current = fn(current); };
  const full = await autoSyncPluggyVia(() => current, apply, { now, fetchImpl: net.fetchImpl });
  assert.equal(full.changed, false);
  assert.equal(current.accounts.filter((a) => a.pluggy).length, 0);
  assert.equal(current.txs.length, 0);
  assert.equal(current.pluggy![0].lastSyncAt, iso(NOW - 2 * DAY_MS));
  assert.equal(current.pluggy![0].lastStatus, undefined);
  assert.equal(current.pluggy![0].itemUpdatedAt, undefined);

  // light probe on a recent connection
  let probe = mkState([conn('a', 'http://a.test', ['ia'], { lastSyncAt: iso(NOW - 3600_000) })]);
  const probeNet = makeNet({
    'http://a.test': api('a', [{ id: 'ia', name: 'Banco A', lastUpdatedAt: STAMP, accounts: [bank1()] }]),
  }, {
    onAuth: () => {
      const old = probe.pluggy![0];
      probe = { ...probe, pluggy: [{ ...old, clientId: 'new-client', clientSecret: 'new-secret', baseUrl: 'http://new.test' }] };
    },
  });
  const probeApply = (fn: (s: State) => State) => { probe = fn(probe); };
  const light = await autoSyncPluggyVia(() => probe, probeApply, { now, fetchImpl: probeNet.fetchImpl });
  assert.equal(light.changed, false);
  assert.equal(probe.pluggy![0].lastProbeAt, undefined);
  assert.equal(probe.pluggy![0].lastStatus, undefined);
  assert.equal(probe.accounts.filter((a) => a.pluggy).length, 0);
});

function namedAccount(id: string, name: string | undefined, type = 'BANK', balance = 100) {
  const account = type === 'CREDIT' ? card(id, balance, 'BRL') : bank(id, balance, 'BRL');
  return { account: { ...account, name }, txs: [] };
}

test('new accounts use each remote account name, isolated per API and stable across syncs', async () => {
  const net = makeNet({
    'http://a.test': api('a', [{
      id: 'ia', name: 'Instituição A', accounts: [
        namedAccount('b1', 'Conta Corrente'),
        namedAccount('b2', 'Poupança'),
        namedAccount('c1', 'Cartão Platinum', 'CREDIT', 0),
      ],
    }]),
    'http://b.test': api('b', [{
      id: 'ib', name: 'Instituição B', accounts: [namedAccount('b1', 'Conta da Esposa')],
    }]),
  });
  let s = mkState([conn('a', 'http://a.test', ['ia']), conn('b', 'http://b.test', ['ib'])]);
  s = (await runAll(s, { now, fetchImpl: net.fetchImpl })).state;
  const names = Object.fromEntries(s.accounts.filter((a) => a.pluggy).map((a) => [a.id, a.name]));
  assert.equal(names['pg-a-b1'], 'Conta Corrente');
  assert.equal(names['pg-a-b2'], 'Poupança');
  assert.equal(names['pg-a-c1'], 'Cartão Platinum');
  assert.equal(names['pg-b-b1'], 'Conta da Esposa');
  assert.equal(s.accounts.filter((a) => a.pluggy).length, 4);
  const ids = s.accounts.filter((a) => a.pluggy).map((a) => a.id).sort();
  s = (await runAll(s, { now, fetchImpl: net.fetchImpl })).state;
  assert.deepEqual(s.accounts.filter((a) => a.pluggy).map((a) => a.id).sort(), ids);
  assert.equal(net.calls.filter((c) => c === '/items').length, 0);
});

test('legacy automatic names update in place preserving identity and other properties', async () => {
  const net = makeNet({
    'http://a.test': api('a', [{ id: 'ia', name: 'Itaú', institution: 'Itau Inst', accounts: [namedAccount('b1', 'Conta Corrente', 'BANK', 500)] }]),
  });
  const base = mkState([conn('a', 'http://a.test', ['ia'])]);
  const legacy = 'Itaú · API a';
  const existing: State['accounts'][number] = {
    id: 'pg-a-b1', name: legacy, icon: 'wallet', color: '#000000', currency: 'BRL', initial: 123,
    includeInTotal: false, archived: false, order: 7, note: 'minha nota',
    pluggy: { apiId: 'a', accountId: 'b1', type: 'BANK' },
  };
  let s = { ...base, accounts: [...base.accounts, existing] };
  const before = s.accounts.find((a) => a.id === 'pg-a-b1')!;
  s = (await runAll(s, { now, fetchImpl: net.fetchImpl })).state;
  const after = s.accounts.find((a) => a.id === 'pg-a-b1')!;
  assert.equal(after.name, 'Conta Corrente');
  assert.equal(after.pluggy?.lastAutoName, 'Conta Corrente');
  assert.equal(after.pluggy?.nameCustomized, undefined);
  assert.equal(after.id, before.id);
  assert.deepEqual({ icon: after.icon, color: after.color, order: after.order, archived: after.archived, includeInTotal: after.includeInTotal, note: after.note }, { icon: 'wallet', color: '#000000', order: 7, archived: false, includeInTotal: false, note: 'minha nota' });
  assert.equal(s.accounts.filter((a) => a.pluggy?.accountId === 'b1').length, 1);
  assert.equal(balances(s).get('pg-a-b1'), 50000);
});

test('legacy formula whose item name matches the connection under fold also updates', async () => {
  const net = makeNet({
    'http://a.test': api('a', [{ id: 'ia', name: 'api a', institution: 'X', accounts: [namedAccount('b1', 'Conta Nova')] }]),
  });
  const base = mkState([conn('a', 'http://a.test', ['ia'])]);
  const oldName = 'API a';
  let s = { ...base, accounts: [...base.accounts, {
    id: 'pg-a-b1', name: oldName, icon: 'bank', color: '#3D8BFF', currency: 'BRL', initial: 0,
    includeInTotal: true, archived: false, order: 2, pluggy: { apiId: 'a', accountId: 'b1', type: 'BANK' },
  }] };
  s = (await runAll(s, { now, fetchImpl: net.fetchImpl })).state;
  assert.equal(s.accounts.find((a) => a.id === 'pg-a-b1')?.name, 'Conta Nova');
});

test('names different from the legacy formula are kept and flagged as customized', async () => {
  const net = makeNet({
    'http://a.test': api('a', [{ id: 'ia', name: 'Itaú', accounts: [namedAccount('b1', 'Conta Corrente')] }]),
  });
  const base = mkState([conn('a', 'http://a.test', ['ia'])]);
  let s = { ...base, accounts: [...base.accounts, {
    id: 'pg-a-b1', name: 'Nome escolhido', icon: 'bank', color: '#3D8BFF', currency: 'BRL', initial: 0,
    includeInTotal: true, archived: false, order: 2, pluggy: { apiId: 'a', accountId: 'b1', type: 'BANK' },
  }] };
  s = (await runAll(s, { now, fetchImpl: net.fetchImpl })).state;
  const acc = s.accounts.find((a) => a.id === 'pg-a-b1')!;
  assert.equal(acc.name, 'Nome escolhido');
  assert.equal(acc.pluggy?.nameCustomized, true);
  assert.equal(acc.pluggy?.lastAutoName, undefined);
});

test('missing or blank remote names use deterministic fallbacks and never rename existing accounts', async () => {
  const net = makeNet({
    'http://a.test': api('a', [
      { id: 'i1', name: 'Item Um', accounts: [namedAccount('b1', undefined)] },
      { id: 'i2', name: '', institution: 'Instituição', accounts: [namedAccount('b2', '   ')] },
      { id: 'i3', name: '', institution: '', accounts: [namedAccount('b3', '')] },
      { id: 'i4', name: '', institution: '', accounts: [namedAccount('b4', '')] },
    ]),
  });
  const custom = conn('a', 'http://a.test', ['i1', 'i2', 'i3', 'i4', 'i5']);
  custom.name = '';
  const base = mkState([custom]);
  let s = { ...base, accounts: [...base.accounts, {
    id: 'pg-a-existing', name: 'Nome preservado', icon: 'bank', color: '#3D8BFF', currency: 'BRL', initial: 0,
    includeInTotal: true, archived: false, order: 2, pluggy: { apiId: 'a', accountId: 'existing', type: 'BANK' },
  }] };
  net.api('http://a.test').items.push({ id: 'i5', name: 'Item Cinco', accounts: [namedAccount('existing', '  ')] });
  s = (await runAll(s, { now, fetchImpl: net.fetchImpl })).state;
  const byId = Object.fromEntries(s.accounts.filter((a) => a.pluggy).map((a) => [a.id, a.name]));
  assert.equal(byId['pg-a-b1'], 'Item Um');
  assert.equal(byId['pg-a-b2'], 'Instituição');
  assert.equal(byId['pg-a-b3'], 'Conta Pluggy');
  assert.equal(byId['pg-a-b4'], 'Conta Pluggy');
  assert.equal(byId['pg-a-existing'], 'Nome preservado');
  assert.equal(net.calls.filter((c) => c === '/items').length, 0);
});

test('remote name changes update lastAutoName until the user customizes the name', async () => {
  const item = { id: 'ia', name: 'Banco A', accounts: [namedAccount('b1', 'Nome 1')] };
  const net = makeNet({ 'http://a.test': api('a', [item]) });
  let s = mkState([conn('a', 'http://a.test', ['ia'])]);
  s = (await runAll(s, { now, fetchImpl: net.fetchImpl })).state;
  assert.equal(s.accounts.find((a) => a.pluggy?.accountId === 'b1')?.name, 'Nome 1');
  item.accounts[0].account.name = 'Nome 2';
  s = (await runAll(s, { now, fetchImpl: net.fetchImpl })).state;
  let acc = s.accounts.find((a) => a.pluggy?.accountId === 'b1')!;
  assert.equal(acc.name, 'Nome 2');
  assert.equal(acc.pluggy?.lastAutoName, 'Nome 2');

  s = { ...s, accounts: s.accounts.map((a) => (a.id === acc.id ? { ...a, name: 'Meu nome', pluggy: { ...a.pluggy!, nameCustomized: true } } : a)) };
  item.accounts[0].account.name = 'Nome 3';
  s = (await runAll(s, { now, fetchImpl: net.fetchImpl })).state;
  acc = s.accounts.find((a) => a.pluggy?.accountId === 'b1')!;
  assert.equal(acc.name, 'Meu nome');
  assert.equal(acc.pluggy?.lastAutoName, 'Nome 2');

  s = { ...s, accounts: s.accounts.map((a) => (a.id === acc.id ? { ...a, name: 'Divergente', pluggy: { ...a.pluggy!, nameCustomized: undefined } } : a)) };
  item.accounts[0].account.name = 'Nome 4';
  s = (await runAll(s, { now, fetchImpl: net.fetchImpl })).state;
  acc = s.accounts.find((a) => a.pluggy?.accountId === 'b1')!;
  assert.equal(acc.name, 'Divergente');
  assert.equal(acc.pluggy?.nameCustomized, true);
});

test('deterministic ID collision refuses that connection without partial writes and keeps the other API', async () => {
  const net = makeNet({
    'http://a.test': api('a', [{ id: 'ia', name: 'Banco A', accounts: [namedAccount('b1', 'Conta A')] }]),
    'http://b.test': api('b', [{ id: 'ib', name: 'Banco B', accounts: [namedAccount('b1', 'Conta B')] }]),
  });
  const base = mkState([conn('a', 'http://a.test', ['ia']), conn('b', 'http://b.test', ['ib'])]);
  const occupied = {
    id: 'pg-a-b1', name: 'Conta de outra dupla', icon: 'bank', color: '#000000', currency: 'BRL', initial: 999,
    includeInTotal: false, archived: false, order: 9, note: 'intocada',
    pluggy: { apiId: 'x', accountId: 'y', type: 'BANK' },
  };
  const start = { ...base, accounts: [...base.accounts, occupied], txs: [...base.txs], transfers: [...base.transfers] };
  const r = await runAll(start, { now, fetchImpl: net.fetchImpl });
  assert.equal(r.result.ok, false);
  assert.ok(r.result.errors.some((e) => /collision/.test(e)));
  assert.equal(r.result.errors.some((e) => e.includes('pg-a-b1')), false);
  const kept = r.state.accounts.filter((a) => a.id === 'pg-a-b1');
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].pluggy, { apiId: 'x', accountId: 'y', type: 'BANK' });
  assert.deepEqual({ name: kept[0].name, initial: kept[0].initial, note: kept[0].note }, { name: 'Conta de outra dupla', initial: 999, note: 'intocada' });
  assert.equal(r.state.accounts.some((a) => a.pluggy?.apiId === 'a'), false);
  assert.equal(r.state.accounts.some((a) => a.pluggy?.apiId === 'b'), true);
  assert.equal(r.state.txs.length, start.txs.length);
  assert.equal(r.state.transfers.length, start.transfers.length);
});

test('collision after a recent probe is isolated and the next API still syncs', async () => {
  const newer = '2026-11-09T10:00:00.000Z';
  const net = makeNet({
    'http://a.test': api('a', [{
      id: 'ia', name: 'Banco A', lastUpdatedAt: newer,
      accounts: [namedAccount('b1', 'Conta A'), namedAccount('b2', 'Conta Colidente')],
    }]),
    'http://b.test': api('b', [{ id: 'ib', name: 'Banco B', accounts: [namedAccount('b1', 'Conta B')] }]),
  });
  const base = mkState([
    conn('a', 'http://a.test', ['ia'], { lastSyncAt: iso(NOW - 3600_000), itemUpdatedAt: { ia: '2026-11-08T00:00:00.000Z' } }),
    conn('b', 'http://b.test', ['ib']),
  ]);
  const occupied = {
    id: 'pg-a-b2', name: 'Conta ocupada', icon: 'bank', color: '#000000', currency: 'BRL', initial: 777,
    includeInTotal: false, archived: false, order: 9, note: 'intocada',
    pluggy: { apiId: 'x', accountId: 'y', type: 'BANK' },
  };
  const start = { ...base, accounts: [...base.accounts, occupied], txs: [...base.txs], transfers: [...base.transfers] };
  const r = await auto(start, { now, fetchImpl: net.fetchImpl });
  assert.equal(r.state.accounts.some((a) => a.pluggy?.apiId === 'a'), false);
  assert.equal(r.state.accounts.some((a) => a.pluggy?.apiId === 'b'), true);
  const a = r.state.pluggy!.find((c) => c.id === 'a')!;
  assert.equal(a.lastStatus, 'error');
  assert.ok(String(a.lastError).includes('collision'));
  assert.equal(String(a.lastError).includes('pg-a-b2'), false);
  assert.equal(a.lastSyncAt, iso(NOW - 3600_000));
  assert.equal(a.accountSync, undefined);
  assert.equal(a.itemUpdatedAt?.ia, '2026-11-08T00:00:00.000Z');
  const kept = r.state.accounts.filter((x) => x.id === 'pg-a-b2');
  assert.equal(kept.length, 1);
  assert.deepEqual({ name: kept[0].name, initial: kept[0].initial, note: kept[0].note }, { name: 'Conta ocupada', initial: 777, note: 'intocada' });
  assert.equal(r.state.txs.length, start.txs.length);
  assert.equal(r.state.transfers.length, start.transfers.length);
});

test('a stale configuration during post-probe collection publishes no error on the new configuration', async () => {
  const newer = '2026-11-09T10:00:00.000Z';
  let current = mkState([
    conn('a', 'http://a.test', ['ia'], { lastSyncAt: iso(NOW - 3600_000), itemUpdatedAt: { ia: '2026-11-08T00:00:00.000Z' } }),
    conn('b', 'http://b.test', ['ib']),
  ]);
  let auths = 0;
  const net = makeNet({
    'http://a.test': api('a', [{
      id: 'ia', name: 'Banco A', lastUpdatedAt: newer,
      accounts: [namedAccount('b1', 'Conta A'), namedAccount('b2', 'Conta Colidente')],
    }]),
    'http://b.test': api('b', [{ id: 'ib', name: 'Banco B', accounts: [namedAccount('b1', 'Conta B')] }]),
  }, {
    onAuth: () => {
      auths++;
      if (auths !== 2) return;
      const old = current.pluggy![0];
      current = { ...current, pluggy: [{ ...old, clientId: 'new-client', clientSecret: 'new-secret', baseUrl: 'http://new.test' }, ...(current.pluggy ?? []).slice(1)] };
    },
  });
  const occupied = {
    id: 'pg-a-b2', name: 'Conta ocupada', icon: 'bank', color: '#000000', currency: 'BRL', initial: 777,
    includeInTotal: false, archived: false, order: 9, pluggy: { apiId: 'x', accountId: 'y', type: 'BANK' },
  };
  current = { ...current, accounts: [...current.accounts, occupied] };
  const apply = (fn: (s: State) => State) => { current = fn(current); };
  const r = await autoSyncPluggyVia(() => current, apply, { now, fetchImpl: net.fetchImpl });
  assert.equal(r.changed, true);
  const a = current.pluggy!.find((c) => c.id === 'a')!;
  assert.equal(a.clientId, 'new-client');
  assert.equal(a.lastStatus, undefined);
  assert.equal(a.lastError, undefined);
  assert.equal(current.accounts.some((x) => x.pluggy?.apiId === 'a'), false);
  assert.equal(current.accounts.some((x) => x.pluggy?.apiId === 'b'), true);
});
