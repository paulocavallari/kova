import type { PluggyAccount, PluggyTx } from '../src/lib/pluggy';

/** Minimal deterministic HTTP fake for the Meu Pluggy contract; no network, no real data. */
export interface FakeAccount {
  account: PluggyAccount;
  txs: PluggyTx[];
  bills?: { id: string; dueDate: string; totalAmount: number; totalAmountCurrencyCode: string }[];
  billsStatus?: number;
  failStatus?: number;
}

export interface FakeItem {
  id: string;
  name: string;
  institution?: string;
  lastUpdatedAt?: string;
  updatedAt?: string;
  accounts: FakeAccount[];
  failStatus?: number;
}

export interface FakeApi {
  clientId: string;
  clientSecret: string;
  items: FakeItem[];
}

export interface FakeNet {
  fetchImpl: typeof fetch;
  calls: string[];
  maxConcurrent: number;
  api(key: string): FakeApi;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function makeNet(apis: Record<string, FakeApi>, opts: { onAuth?: (api: FakeApi) => void } = {}): FakeNet {
  const calls: string[] = [];
  let active = 0;
  let maxConcurrent = 0;
  const wait = () => new Promise((r) => setTimeout(r, 2));
  const findAccount = (api: FakeApi, accountId: string): { item: FakeItem; acc: FakeAccount } | undefined => {
    for (const item of api.items) for (const acc of item.accounts) if (acc.account.id === accountId) return { item, acc };
    return undefined;
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const api = apis[url.origin];
    calls.push(url.pathname + url.search);
    if (!api) return json(404, { message: 'unknown host' });
    if (init?.method === 'POST' && url.pathname === '/auth') {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      await wait();
      active--;
      const body = JSON.parse(String(init.body ?? '{}'));
      if (body.clientId !== api.clientId || body.clientSecret !== api.clientSecret) return json(401, { message: 'bad credentials' });
      opts.onAuth?.(api);
      return json(200, { apiKey: `k-${api.clientId}` });
    }
    const key = (init?.headers as Record<string, string> | undefined)?.['X-API-KEY'];
    if (key !== `k-${api.clientId}`) return json(401, { message: 'wrong key' });
    if (url.pathname === '/items') return json(403, { message: 'Forbidden' });
    if (url.pathname.startsWith('/items/')) {
      const item = api.items.find((x) => x.id === decodeURIComponent(url.pathname.slice('/items/'.length)));
      if (!item) return json(404, { message: 'no item' });
      if (item.failStatus) return json(item.failStatus, { message: 'item failed' });
      return json(200, { id: item.id, name: item.name, institution: item.institution, status: 'UPDATED', lastUpdatedAt: item.lastUpdatedAt, updatedAt: item.updatedAt });
    }
    if (url.pathname === '/bills') {
      const found = findAccount(api, url.searchParams.get('accountId') ?? '');
      if (!found) return json(404, { message: 'no account' });
      if (found.acc.billsStatus) return json(found.acc.billsStatus, { message: 'bills failed' });
      const page = Number(url.searchParams.get('page') ?? '1');
      const all = found.acc.bills ?? [];
      const half = Math.ceil(all.length / 2);
      const results = all.length > 1 ? (page === 2 ? all.slice(half) : all.slice(0, half)) : all;
      return json(200, { results, page, totalPages: all.length > 1 ? 2 : 1 });
    }
    if (url.pathname === '/accounts') {
      const item = api.items.find((x) => x.id === url.searchParams.get('itemId'));
      if (!item) return json(404, { message: 'no item' });
      return json(200, { results: item.accounts.map((a) => a.account), page: 1, totalPages: 1 });
    }
    if (url.pathname === '/v2/transactions' || url.pathname === '/transactions') {
      const found = findAccount(api, url.searchParams.get('accountId') ?? '');
      if (!found) return json(404, { message: 'no account' });
      if (found.acc.failStatus) return json(found.acc.failStatus, { message: 'transactions failed' });
      const from = url.searchParams.get('dateFrom');
      const results = found.acc.txs.filter((t) => !from || t.date >= from);
      if (url.pathname === '/transactions') return json(200, { results, page: 1, totalPages: 1 });
      return json(200, { results, next: null });
    }
    return json(404, { message: 'not found' });
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    get maxConcurrent() {
      return maxConcurrent;
    },
    api(key: string) {
      const api = apis[key];
      if (!api) throw new Error(`unknown api ${key}`);
      return api;
    },
  };
}

export function testConn(id: string, baseUrl: string, itemIds: string[], extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `API ${id}`,
    clientId: `client-${id}`,
    clientSecret: `secret-${id}`,
    itemIds,
    baseUrl,
    enabled: true,
    auto: true,
    ...extra,
  };
}

export const tx = (id: string, amount: number, date: string, extra: Partial<PluggyTx> = {}): PluggyTx => ({
  id,
  amount,
  date,
  ...extra,
});

export const bank = (id: string, balance: number, currencyCode = 'BRL', name = 'Conta'): PluggyAccount => ({
  id,
  name,
  type: 'BANK',
  balance,
  currencyCode,
});

export const card = (id: string, balance: number, currencyCode = 'BRL', name = 'Cartão'): PluggyAccount => ({
  id,
  name,
  type: 'CREDIT',
  balance,
  currencyCode,
});
