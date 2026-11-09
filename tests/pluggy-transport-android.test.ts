import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/lib/defaults';
import type { PluggyConn, State } from '../src/lib/types';

interface BridgeCall {
  plugin: string;
  method: string;
  options: any;
}
const calls: BridgeCall[] = [];
let fetchCalls = 0;
let handler: (options: any) => any = () => ({ status: 200, data: {} });

// Android platform and a synthetic bridge must exist before @capacitor/core is first imported.
(globalThis as any).CapacitorCustomPlatform = { name: 'android' };
(globalThis as any).Capacitor = {
  PluginHeaders: [{ name: 'CapacitorHttp', methods: [{ name: 'request', rtype: 'promise' }] }],
  nativePromise: async (plugin: string, method: string, options: any) => {
    calls.push({ plugin, method, options });
    return handler(options);
  },
};
(globalThis as any).fetch = async () => {
  fetchCalls++;
  throw new Error('web fetch must not run on Android');
};

const { Capacitor, CapacitorHttp } = await import('@capacitor/core');
const { PluggyClient, PluggyError, syncPluggyVia, testPluggyConn } = await import('../src/lib/pluggy');

const SECRET_A = 'secret-a-android';
const SECRET_B = 'secret-b-android';
const conn = (id: string, secret: string): PluggyConn => ({
  id,
  name: `API ${id}`,
  clientId: `client-${id}`,
  clientSecret: secret,
  itemIds: ['item-a'],
  baseUrl: 'https://api.pluggy.ai',
  enabled: true,
  auto: true,
});

function apiHandler(options: any) {
  const url = new URL(options.url);
  const page = Number(url.searchParams.get('page') ?? '1');
  if (url.pathname === '/auth' && options.method === 'POST') {
    const data = options.data;
    if (data?.clientId === 'client-a' && data?.clientSecret === SECRET_A) return { status: 200, data: { apiKey: 'key-a' } };
    if (data?.clientId === 'client-b' && data?.clientSecret === SECRET_B) return { status: 200, data: { apiKey: 'key-b' } };
    return { status: 401, data: { message: 'bad credentials' } };
  }
  const key = options.headers?.['X-API-KEY'];
  if (key !== 'key-a' && key !== 'key-b') return { status: 401, data: { message: 'wrong key' } };
  if (url.pathname === '/items/item-a') return { status: 200, data: { id: 'item-a', name: 'Banco A', lastUpdatedAt: '2026-11-08T10:00:00.000Z' } };
  if (url.pathname === '/items/item-string') return { status: 200, data: '{"id":"item-string","name":"Banco String"}' };
  if (url.pathname === '/items/item-bad-json') return { status: 200, data: 'not json' };
  if (url.pathname === '/items/item-fail') return { status: 500, data: { message: 'server error' } };
  if (url.pathname === '/accounts') {
    if (url.searchParams.get('itemId') === 'item-a' && page === 2) {
      return { status: 200, data: { results: [{ id: 'acc-2', type: 'CREDIT', balance: 0, currencyCode: 'BRL' }], page: 2, totalPages: 2 } };
    }
    return { status: 200, data: { results: [{ id: 'acc-1', type: 'BANK', balance: 1000, currencyCode: 'BRL' }], page: 1, totalPages: 2 } };
  }
  if (url.pathname === '/v2/transactions') {
    const accountId = url.searchParams.get('accountId');
    if (accountId === 'acc-404') return { status: 404, data: { message: 'not found' } };
    if (accountId === 'acc-405') return { status: 405, data: { message: 'method not allowed' } };
    if (accountId === 'acc-pages' && page === 2) return { status: 200, data: { results: [{ id: 'p2', amount: 2, date: '2026-11-02', type: 'DEBIT' }], page: 2, totalPages: 2 } };
    if (accountId === 'acc-pages') return { status: 200, data: { results: [{ id: 'p1', amount: 1, date: '2026-11-01', type: 'DEBIT' }], page: 1, totalPages: 2 } };
    if (url.searchParams.get('cursor') === 'c1') return { status: 200, data: { results: [{ id: 't2', amount: 20, date: '2026-11-02', type: 'CREDIT' }], next: null } };
    return { status: 200, data: { results: [{ id: 't1', amount: 10, date: '2026-11-01', type: 'DEBIT' }], next: `?accountId=${accountId}&cursor=c1` } };
  }
  if (url.pathname === '/transactions') {
    return { status: 200, data: { results: [{ id: 'fallback', amount: 7, date: '2026-10-30', type: 'DEBIT' }], page: 1, totalPages: 1 } };
  }
  return { status: 404, data: { message: 'not found' } };
}

test('android platform uses the real CapacitorHttp bridge and never fetch', async () => {
  handler = apiHandler;
  assert.equal(Capacitor.getPlatform(), 'android');
  const fake = () => Promise.resolve({ status: 200, data: {} });
  try { (CapacitorHttp as any).request = fake; } catch { /* proxy setter is irrelevant */ }
  assert.notEqual(CapacitorHttp.request, fake, 'o Proxy do core não aceita atribuição simples');

  const client = new PluggyClient(conn('a', SECRET_A));
  await client.auth();
  assert.equal(fetchCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].plugin, 'CapacitorHttp');
  assert.equal(calls[0].method, 'request');
  assert.equal(calls[0].options.url, 'https://api.pluggy.ai/auth');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(calls[0].options.data, { clientId: 'client-a', clientSecret: SECRET_A });
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');

  const item = await client.item('item-a');
  assert.equal(item.name, 'Banco A');
  assert.equal(calls[1].options.headers['X-API-KEY'], 'key-a');
  const accounts = await client.accounts('item-a');
  assert.deepEqual(accounts.map((a) => a.id), ['acc-1', 'acc-2']);
  const txs = await client.transactions('acc-1', '2026-01-01');
  assert.deepEqual(txs.map((t) => t.id), ['t1', 't2']);
  assert.ok(calls.some((c) => c.options.url.includes('/v2/transactions?accountId=acc-1&cursor=c1')));
  assert.equal(fetchCalls, 0);
});

test('android transport preserves statuses, JSON string/object, pages, fallback and rejects with a safe error', async () => {
  handler = apiHandler;
  const client = new PluggyClient(conn('a', SECRET_A));
  await client.auth();

  assert.equal((await client.item('item-string')).id, 'item-string');
  await assert.rejects(() => client.item('item-bad-json'), /invalid item/);
  await assert.rejects(() => client.item('item-fail'), /HTTP 500/);
  const fallback404 = await client.transactions('acc-404');
  assert.deepEqual(fallback404.map((t) => t.id), ['fallback']);
  const fallback405 = await client.transactions('acc-405');
  assert.deepEqual(fallback405.map((t) => t.id), ['fallback']);
  const pages = await client.transactions('acc-pages');
  assert.deepEqual(pages.map((t) => t.id), ['p1', 'p2']);

  handler = () => { throw new Error(`bridge exploded ${SECRET_A}`); };
  await assert.rejects(() => client.item('item-a'), (e: unknown) => {
    assert.ok(e instanceof PluggyError);
    assert.equal(String((e as Error).message).includes(SECRET_A), false);
    return true;
  });
});

test('android bridge isolates tokens between connections and injected fetch wins', async () => {
  handler = apiHandler;
  const a = new PluggyClient(conn('a', SECRET_A));
  const b = new PluggyClient(conn('b', SECRET_B));
  assert.equal(await a.auth(), 'key-a');
  assert.equal(await b.auth(), 'key-b');
  calls.length = 0;
  await a.item('item-a');
  await b.item('item-a');
  assert.equal(calls[0].options.headers['X-API-KEY'], 'key-a');
  assert.equal(calls[1].options.headers['X-API-KEY'], 'key-b');

  calls.length = 0;
  let injected = 0;
  const injectedFetch = (async () => {
    injected++;
    return new Response(JSON.stringify({ apiKey: 'injected' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const c = new PluggyClient(conn('c', SECRET_A), { fetchImpl: injectedFetch });
  assert.equal(await c.auth(), 'injected');
  assert.equal(injected, 1);
  assert.equal(calls.length, 0);
});

test('testPluggyConn and sync use the bridge when no fetch is injected', async () => {
  handler = apiHandler;
  const testResult = await testPluggyConn(conn('a', SECRET_A));
  assert.equal(testResult.ok, true);
  assert.equal(fetchCalls, 0);

  let current: State = { ...initialState('pt'), pluggy: [conn('a', SECRET_A)] };
  const apply = (fn: (s: State) => State) => { current = fn(current); };
  const r = await syncPluggyVia(() => current, apply, 'a', { now: () => Date.parse('2026-11-09T12:00:00Z') });
  assert.equal(r.ok, true);
  assert.equal(current.accounts.filter((a) => a.pluggy).length, 2);
  assert.ok(current.txs.length > 0);
  assert.equal(fetchCalls, 0);
});
