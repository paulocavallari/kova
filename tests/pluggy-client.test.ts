import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PluggyClient, PluggyError, redactSecret } from '../src/lib/pluggy';

const SECRET_A = 'secret-api-a-987';
const SECRET_B = 'secret-api-b-654';

interface Seen {
  path: string;
  key: string;
}

function startFake(): Promise<{ base: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const key = String(req.headers['x-api-key'] ?? '');
    seen.push({ path: u.pathname + u.search, key });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && u.pathname === '/auth') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        if (body.clientId === 'client-a' && body.clientSecret === SECRET_A) return send(200, { apiKey: 'key-a' });
        if (body.clientId === 'client-b' && body.clientSecret === SECRET_B) return send(200, { apiKey: 'key-b' });
        send(401, { message: 'bad credentials' });
      });
      return;
    }
    if (u.pathname === '/items') return send(403, { message: 'Forbidden' });
    if (u.pathname.startsWith('/items/')) {
      const id = u.pathname.slice('/items/'.length);
      const expected = id.startsWith('b-') ? 'key-b' : 'key-a';
      if (key !== expected) return send(401, { message: 'wrong key' });
      return send(200, { id, name: id === 'b-1' ? 'Banco B' : 'Banco A', status: 'UPDATED', lastUpdatedAt: '2026-11-08T10:00:00.000Z' });
    }
    if (u.pathname === '/accounts') {
      if (u.searchParams.get('itemId') === 'b-1') return send(200, { results: [{ id: 'acc-b', type: 'BANK', balance: 10, currencyCode: 'BRL' }], page: 1, totalPages: 1 });
      if (u.searchParams.get('page') === '2') return send(200, { results: [{ id: 'acc-2', type: 'CREDIT', balance: -50, currencyCode: 'BRL' }], page: 2, totalPages: 2 });
      return send(200, { results: [{ id: 'acc-1', type: 'BANK', balance: 100, currencyCode: 'BRL' }], page: 1, totalPages: 2 });
    }
    if (u.pathname === '/bills') {
      const account = u.searchParams.get('accountId');
      if (account === 'bills-500') return send(500, { message: 'boom' });
      if (account === 'bills-bad-page') return send(200, { results: [], page: 2, totalPages: 2 });
      if (account === 'bills-conflict') {
        return send(200, { results: [
          { id: 'same', dueDate: '2026-11-10', totalAmount: 10, totalAmountCurrencyCode: 'BRL' },
          { id: 'same', dueDate: '2026-11-11', totalAmount: 20, totalAmountCurrencyCode: 'BRL' },
        ], page: 1, totalPages: 1 });
      }
      if (account === 'bills-bad') return send(200, { results: [{ id: 'x', dueDate: '2026-02-30', totalAmount: 1, totalAmountCurrencyCode: 'BRL' }], page: 1, totalPages: 1 });
      if (account === 'bills-no-z') return send(200, { results: [{ id: 'noz', dueDate: '2023-07-20T00:00:00', totalAmount: 10.25, totalAmountCurrencyCode: 'BRL' }], page: 1, totalPages: 1 });
      if (account === 'bills-z') return send(200, { results: [{ id: 'z', dueDate: '2023-07-20T00:00:00Z', totalAmount: 10.25, totalAmountCurrencyCode: 'BRL' }], page: 1, totalPages: 1 });
      if (account === 'bills-bad-hour') return send(200, { results: [{ id: 'h', dueDate: '2023-07-20T25:00:00', totalAmount: 1, totalAmountCurrencyCode: 'BRL' }], page: 1, totalPages: 1 });
      if (account === 'bills-suffix') return send(200, { results: [{ id: 'x', dueDate: '2026-11-05garbage', totalAmount: 1, totalAmountCurrencyCode: 'BRL' }], page: 1, totalPages: 1 });
      if (account === 'bills-currency') return send(200, { results: [{ id: 'x', dueDate: '2026-11-05', totalAmount: 1, totalAmountCurrencyCode: 'ABCDE' }], page: 1, totalPages: 1 });
      if (account === 'bills-shrink') {
        return send(200, { results: [{ id: `p${u.searchParams.get('page')}`, dueDate: '2026-11-05', totalAmount: 1, totalAmountCurrencyCode: 'BRL' }], page: Number(u.searchParams.get('page')), totalPages: u.searchParams.get('page') === '1' ? 3 : 2 });
      }
      if (account === 'bills-grow') {
        return send(200, { results: [{ id: `p${u.searchParams.get('page')}`, dueDate: '2026-11-05', totalAmount: 1, totalAmountCurrencyCode: 'BRL' }], page: Number(u.searchParams.get('page')), totalPages: u.searchParams.get('page') === '1' ? 2 : 3 });
      }
      if (u.searchParams.get('page') === '2') {
        return send(200, { results: [{ id: 'bill-2', dueDate: '2026-12-10', totalAmount: 12.34, totalAmountCurrencyCode: 'BRL' }], page: 2, totalPages: 2 });
      }
      return send(200, { results: [
        { id: 'bill-1', dueDate: '2026-11-10', totalAmount: 100.5, totalAmountCurrencyCode: 'brl' },
        { id: 'bill-neg', dueDate: '2026-11-20', totalAmount: -5.5, totalAmountCurrencyCode: 'BRL' },
      ], page: 1, totalPages: 2 });
    }
    if (u.pathname === '/v2/transactions') {
      const account = u.searchParams.get('accountId');
      if (account === 'acc-404') return send(404, { message: 'not found' });
      if (account === 'acc-405') return send(405, { message: 'method not allowed' });
      if (account === 'acc-toomany') return send(200, { results: [], page: 1, totalPages: 201 });
      if (account === 'acc-pages') {
        if (u.searchParams.get('page') === '2') return send(200, { results: [{ id: 'pg2', amount: 2, date: '2026-10-02', type: 'DEBIT' }], page: 2, totalPages: 2 });
        return send(200, { results: [{ id: 'pg1', amount: 1, date: '2026-10-01', type: 'DEBIT' }], page: 1, totalPages: 2 });
      }
      if (account === 'acc-loop') return send(200, { results: [], next: '?accountId=acc-loop&cursor=same' });
      if (u.searchParams.get('cursor') === 'c1') {
        return send(200, { results: [{ id: 't2', amount: 20, date: '2026-11-02', type: 'CREDIT' }], next: null });
      }
      return send(200, { results: [{ id: 't1', amount: 12.5, date: '2026-11-01', type: 'DEBIT', operationType: 'PIX' }], next: `?accountId=${account}&cursor=c1` });
    }
    if (u.pathname === '/transactions') {
      return send(200, { results: [{ id: 'fallback-1', amount: 7, date: '2026-10-30', type: 'DEBIT' }], page: 1, totalPages: 1 });
    }
    send(500, { message: `boom ${SECRET_A}` });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function conn(id: string, clientId: string, secret: string, baseUrl: string) {
  return { id, clientId, clientSecret: secret, baseUrl };
}

test('Meu Pluggy client', async (t) => {
  const fake = await startFake();
  t.after(() => fake.close());

  const a = new PluggyClient(conn('a', 'client-a', SECRET_A, fake.base));
  const b = new PluggyClient(conn('b', 'client-b', SECRET_B, fake.base));
  assert.notEqual(await a.auth(), await b.auth());

  await t.test('auth is isolated per connection and never calls GET /items', async () => {
    const item = await a.item('item-1');
    assert.equal(item.id, 'item-1');
    assert.equal(item.lastUpdatedAt, '2026-11-08T10:00:00.000Z');
    assert.equal((await b.item('b-1')).name, 'Banco B');
    await assert.rejects(() => a.item('b-1'), /HTTP 401/);
    assert.equal(fake.seen.some((s) => s.path === '/items'), false);
  });

  await t.test('accounts follows page/totalPages', async () => {
    const accounts = await a.accounts('item-1');
    assert.deepEqual(accounts.map((x) => x.id), ['acc-1', 'acc-2']);
    assert.equal(accounts[1].type, 'CREDIT');
    assert.equal(accounts[1].balance, -50);
    assert.ok(fake.seen.some((s) => s.path.includes('/accounts?itemId=item-1&page=2')));
  });

  await t.test('v2 cursor is sent literally and repeated cursor is rejected', async () => {
    const txs = await a.transactions('acc-1', '2026-01-01');
    assert.deepEqual(txs.map((x) => x.id), ['t1', 't2']);
    assert.ok(fake.seen.some((s) => s.path === '/v2/transactions?accountId=acc-1&cursor=c1'));
    await assert.rejects(() => a.transactions('acc-loop'), /repeated cursor/);
  });

  await t.test('404 on v2 falls back to page-based /transactions', async () => {
    const txs = await a.transactions('acc-404', '2026-01-01');
    assert.deepEqual(txs.map((x) => x.id), ['fallback-1']);
  });

  await t.test('405 on v2 also falls back to /transactions', async () => {
    const txs = await a.transactions('acc-405', '2026-01-01');
    assert.deepEqual(txs.map((x) => x.id), ['fallback-1']);
  });

  await t.test('v2 without next follows page/totalPages', async () => {
    const txs = await a.transactions('acc-pages', '2026-01-01');
    assert.deepEqual(txs.map((x) => x.id), ['pg1', 'pg2']);
    assert.ok(fake.seen.some((s) => s.path.includes('/v2/transactions?accountId=acc-pages') && s.path.includes('page=2')));
  });

  await t.test('v2 above MAX_PAGES is refused instead of truncated', async () => {
    await assert.rejects(() => a.transactions('acc-toomany'), /pagination limit/);
  });

  await t.test('errors never expose the client secret', async () => {
    const broken = new PluggyClient(conn('c', 'client-a', SECRET_A, `${fake.base}/nowhere`));
    await assert.rejects(() => broken.auth(), (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      assert.equal(msg.includes(SECRET_A), false);
      return e instanceof PluggyError;
    });
    assert.equal(redactSecret(`x ${SECRET_A} y`, SECRET_A), 'x *** y');
  });

  await t.test('invalid base url is refused before any request', () => {
    assert.throws(() => new PluggyClient(conn('d', 'client-a', SECRET_A, 'ftp://nope')), /invalid base url/);
  });
});

test('web default path uses global fetch; injected fetch always wins', async () => {
  const original = globalThis.fetch;
  let webCalls = 0;
  globalThis.fetch = (async () => {
    webCalls++;
    return new Response(JSON.stringify({ apiKey: 'key-web' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const web = new PluggyClient(conn('web', 'client-a', SECRET_A, 'http://web.test'));
    assert.equal(await web.auth(), 'key-web');
    assert.equal(webCalls, 1);

    let injectedCalls = 0;
    const injected = (async () => {
      injectedCalls++;
      return new Response(JSON.stringify({ apiKey: 'key-injected' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const custom = new PluggyClient(conn('custom', 'client-a', SECRET_A, 'http://web.test'), { fetchImpl: injected });
    assert.equal(await custom.auth(), 'key-injected');
    assert.equal(injectedCalls, 1);
    assert.equal(webCalls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('bills pagination, validation, dedupe and negative values', async (t) => {
  const fake = await startFake();
  t.after(() => fake.close());
  const a = new PluggyClient(conn('a', 'client-a', SECRET_A, fake.base));
  await a.auth();
  const bills = await a.bills('acc-bills');
  assert.deepEqual(bills.map((b) => b.id), ['bill-1', 'bill-neg', 'bill-2']);
  assert.equal(bills[0].amountCents, 10050);
  assert.equal(bills[0].currency, 'BRL');
  assert.equal(bills[1].amountCents, -550);
  assert.ok(fake.seen.some((x) => x.path.includes('/bills?accountId=acc-bills') && x.path.includes('page=2')));
  await assert.rejects(() => a.bills('bills-bad-page'), /invalid bills page/);
  await assert.rejects(() => a.bills('bills-conflict'), /conflicting bill/);
  await assert.rejects(() => a.bills('bills-bad'), /invalid bill/);
  await assert.rejects(() => a.bills('bills-suffix'), /invalid bill/);
  await assert.rejects(() => a.bills('bills-bad-hour'), /invalid bill/);
  const noZ = await a.bills('bills-no-z');
  assert.deepEqual({ dueDate: noZ[0].dueDate, amountCents: noZ[0].amountCents }, { dueDate: '2023-07-20', amountCents: 1025 });
  const withZ = await a.bills('bills-z');
  assert.deepEqual({ dueDate: withZ[0].dueDate, amountCents: withZ[0].amountCents }, { dueDate: '2023-07-20', amountCents: 1025 });
  await assert.rejects(() => a.bills('bills-currency'), /invalid bill/);
  await assert.rejects(() => a.bills('bills-shrink'), /inconsistent bills totalPages/);
  await assert.rejects(() => a.bills('bills-grow'), /inconsistent bills totalPages/);
  await assert.rejects(() => a.bills('bills-500'), /HTTP 500/);
});
