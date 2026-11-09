import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { Account, PluggyConn, State, Transfer, Tx } from './types';
import { addDays, balances, fold, toBase } from './calc';
export const PLUGGY_BASE_URL = 'https://api.pluggy.ai';
const MAX_PAGES = 200;
export class PluggyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluggyError';
  }
}
/** Removes a credential from any text before it can reach a log, toast or lastError. */
export function redactSecret(text: string, secret: string): string {
  const value = String(text ?? '');
  return secret ? value.split(secret).join('***') : value;
}
export interface PluggyItem {
  id: string;
  name?: string;
  institution?: string;
  status?: string;
  lastUpdatedAt?: string;
  updatedAt?: string;
}
export interface PluggyAccount {
  id: string;
  name?: string;
  type: string;
  balance: number;
  currencyCode: string;
}
export interface PluggyTx {
  id: string;
  description?: string;
  amount: number;
  type?: string;
  operationType?: string;
  date: string;
  categoryId?: string;
  status?: string;
}
const asRecord = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new PluggyError(`pluggy: invalid ${what}`);
  return v as Record<string, unknown>;
};
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const need = (ok: boolean, msg: string) => {
  if (!ok) throw new PluggyError(msg);
};
const resultsOf = (body: unknown, what: string): unknown[] => {
  const results = asRecord(body, what).results;
  if (!Array.isArray(results)) throw new PluggyError(`pluggy: ${what} without results`);
  return results;
};
function baseUrlOf(conn: Pick<PluggyConn, 'baseUrl'>): string {
  const raw = (conn.baseUrl || PLUGGY_BASE_URL).trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PluggyError('pluggy: invalid base url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PluggyError('pluggy: invalid base url');
  return raw;
}
function parseItem(raw: unknown): PluggyItem {
  const r = asRecord(raw, 'item');
  need(typeof r.id === 'string' && !!r.id, 'pluggy: item without id');
  return { id: r.id as string, name: str(r.name), institution: str(r.institution), status: str(r.status), lastUpdatedAt: str(r.lastUpdatedAt), updatedAt: str(r.updatedAt) };
}
function parseAccount(raw: unknown): PluggyAccount {
  const r = asRecord(raw, 'account');
  need(typeof r.id === 'string' && !!r.id && typeof r.type === 'string' && !!r.type, 'pluggy: invalid account');
  need(typeof r.balance === 'number' && Number.isFinite(r.balance) && typeof r.currencyCode === 'string' && !!r.currencyCode, 'pluggy: invalid account');
  return { id: r.id as string, name: str(r.name), type: (r.type as string).toUpperCase(), balance: r.balance as number, currencyCode: (r.currencyCode as string).toUpperCase() };
}
function parseTx(raw: unknown): PluggyTx {
  const r = asRecord(raw, 'transaction');
  need(typeof r.id === 'string' && !!r.id && typeof r.amount === 'number' && Number.isFinite(r.amount), 'pluggy: invalid transaction');
  need(typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(r.date), 'pluggy: invalid transaction');
  return {
    id: r.id as string,
    description: str(r.description),
    amount: r.amount as number,
    type: str(r.type)?.toUpperCase(),
    operationType: str(r.operationType)?.toUpperCase(),
    date: (r.date as string).slice(0, 10),
    categoryId: str(r.categoryId),
    status: str(r.status),
  };
}
function pageState(body: unknown, what: string): { page: number; totalPages: number } {
  const r = asRecord(body, what);
  const page = typeof r.page === 'number' && Number.isFinite(r.page) ? r.page : 1;
  const total = typeof r.totalPages === 'number' && Number.isFinite(r.totalPages) ? r.totalPages : 1;
  return { page, totalPages: Math.max(1, total) };
}
type ConnAuth = Pick<PluggyConn, 'id' | 'clientId' | 'clientSecret' | 'baseUrl'>;
/** Isolated HTTP client: one instance per Meu Pluggy connection, token never shared. */
export class PluggyClient {
  private readonly base: string;
  private readonly conn: ConnAuth;
  private readonly fetchImpl?: typeof fetch;
  private token = '';
  constructor(conn: ConnAuth, opts: { fetchImpl?: typeof fetch } = {}) {
    this.conn = conn;
    this.base = baseUrlOf(conn);
    this.fetchImpl = opts.fetchImpl;
  }
  /** Android uses the core native bridge; web and injected fetch use the fetch path. */
  private async call(path: string, init: RequestInit = {}): Promise<{ status: number; ok: boolean; body: unknown }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers['X-API-KEY'] = this.token;
    const url = this.base + path;
    if (!this.fetchImpl && Capacitor.getPlatform() === 'android') return this.nativeCall(url, init, headers);
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, headers });
    } catch {
      throw new PluggyError('pluggy: network error');
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, body };
  }
  private async nativeCall(url: string, init: RequestInit, headers: Record<string, string>): Promise<{ status: number; ok: boolean; body: unknown }> {
    const method = (init.method ?? 'GET').toUpperCase();
    let data: unknown;
    if (typeof init.body === 'string' && init.body) {
      try {
        data = JSON.parse(init.body);
      } catch {
        data = init.body;
      }
    }
    let res: { status?: number; data?: unknown };
    try {
      res = await CapacitorHttp.request({ url, method, headers, ...(data !== undefined ? { data } : {}) });
    } catch {
      throw new PluggyError('pluggy: network error');
    }
    const status = typeof res.status === 'number' ? res.status : 0;
    let body = res.data;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = undefined;
      }
    }
    return { status, ok: status >= 200 && status < 300, body };
  }
  private checked(res: { status: number; ok: boolean; body: unknown }): unknown {
    if (!res.ok) throw new PluggyError(`pluggy: HTTP ${res.status}`);
    return res.body;
  }
  async auth(): Promise<string> {
    const res = await this.call('/auth', { method: 'POST', body: JSON.stringify({ clientId: this.conn.clientId, clientSecret: this.conn.clientSecret }) });
    const body = asRecord(this.checked(res), 'auth');
    need(typeof body.apiKey === 'string' && !!body.apiKey, 'pluggy: auth without apiKey');
    this.token = body.apiKey as string;
    return this.token;
  }
  async item(itemId: string): Promise<PluggyItem> {
    need(!!itemId, 'pluggy: empty item id');
    return parseItem(this.checked(await this.call(`/items/${encodeURIComponent(itemId)}`)));
  }
  /** GET /accounts?itemId=…, following page/totalPages. Never depends on GET /items. */
  async accounts(itemId: string): Promise<PluggyAccount[]> {
    need(!!itemId, 'pluggy: empty item id');
    const out: PluggyAccount[] = [];
    for (let guard = 0; guard < MAX_PAGES; guard++) {
      const qs = new URLSearchParams({ itemId, page: String(guard + 1) });
      const body = this.checked(await this.call(`/accounts?${qs.toString()}`));
      for (const raw of resultsOf(body, 'accounts')) out.push(parseAccount(raw));
      const state = pageState(body, 'accounts');
      if (state.totalPages > MAX_PAGES) throw new PluggyError('pluggy: accounts pagination limit');
      if (state.page >= state.totalPages) return out;
    }
    throw new PluggyError('pluggy: accounts pagination limit');
  }
  /** GET /v2/transactions: literal `next` cursor when present, page/totalPages when absent. */
  async transactions(accountId: string, dateFrom?: string): Promise<PluggyTx[]> {
    need(!!accountId, 'pluggy: empty account id');
    const qs = new URLSearchParams({ accountId });
    if (dateFrom) qs.set('dateFrom', dateFrom);
    const base = `/v2/transactions?${qs.toString()}`;
    const first = await this.call(base);
    if (first.status === 404 || first.status === 405) return this.pagedTransactions(`/transactions?${qs.toString()}`);
    const out: PluggyTx[] = [];
    const seen = new Set<string>();
    let body = this.checked(first);
    for (let guard = 0; guard < MAX_PAGES; guard++) {
      for (const raw of resultsOf(body, 'transactions')) out.push(parseTx(raw));
      const info = pageState(body, 'transactions');
      if (info.totalPages > MAX_PAGES) throw new PluggyError('pluggy: transactions pagination limit');
      const cursor = asRecord(body, 'transactions').next;
      if (cursor !== undefined && cursor !== null && cursor !== '') {
        need(typeof cursor === 'string' && cursor.startsWith('?'), 'pluggy: cursor outside query form');
        need(!seen.has(cursor as string), 'pluggy: repeated cursor');
        seen.add(cursor as string);
        body = this.checked(await this.call(`/v2/transactions${cursor}`));
        continue;
      }
      if (info.page >= info.totalPages) return out;
      body = this.checked(await this.call(`${base}&page=${info.page + 1}`));
    }
    throw new PluggyError('pluggy: transactions pagination limit');
  }
  private async pagedTransactions(path: string): Promise<PluggyTx[]> {
    const out: PluggyTx[] = [];
    for (let guard = 1; guard <= MAX_PAGES; guard++) {
      const body = this.checked(await this.call(`${path}${path.includes('?') ? '&' : '?'}page=${guard}`));
      for (const raw of resultsOf(body, 'transactions')) out.push(parseTx(raw));
      const info = pageState(body, 'transactions');
      if (info.totalPages > MAX_PAGES) throw new PluggyError('pluggy: transactions pagination limit');
      if (info.page >= info.totalPages) return out;
    }
    throw new PluggyError('pluggy: transactions pagination limit');
  }
}
type LegRole = 'regular' | 'card' | 'invest';
interface Leg {
  apiId: string;
  txId: string;
  accountId: string;
  currency: string;
  cents: number;
  date: string;
  op: string;
  desc: string;
  role: LegRole;
  dir: 'out' | 'in';
}
const CARD_OPS = new Set(['PAGAMENTO', 'PAGAMENTO_FATURA', 'PAGAMENTO DE FATURA']);
const UTILITY_WORDS = ['energia', 'agua', 'gas', 'internet', 'telefone', 'celular', 'condominio', 'iptu', 'luz', 'saneamento', 'conta de'];
const CARD_WORDS = ['fatura', 'cartao', 'credit card'];
const isUtilityBill = (desc: string) => UTILITY_WORDS.some((w) => fold(desc).includes(w));
const isCardPayment = (op: string, desc: string) => {
  if (isUtilityBill(desc)) return false;
  if (CARD_OPS.has(op)) return true;
  const d = fold(desc);
  return d.includes('credit card payment') || (CARD_WORDS.some((w) => d.includes(w)) && (d.includes('fatura') || d.includes('pagamento')));
};
const isInvestmentMove = (op: string, desc: string) => /RESGATE|APLICACAO/.test(op) || ['resgate', 'aplicacao', 'cdb', 'fundo'].some((w) => fold(desc).includes(w));
const isTransferLike = (op: string, desc: string) => /PIX|TED|DOC|TRANSFER/.test(op) || ['pix', 'ted ', 'doc ', 'transferencia'].some((w) => fold(desc).includes(w));
const legKey = (apiId: string, txId: string) => `${apiId}|${txId}`;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
function normalizeLeg(apiId: string, account: Account, tx: PluggyTx): Leg | null {
  const cents = Math.round(Math.abs(tx.amount) * 100);
  if (!cents) return null;
  const op = tx.operationType ?? '';
  const base = { apiId, txId: tx.id, accountId: account.id, currency: account.currency, cents, date: tx.date, op, desc: tx.description ?? '' };
  if (account.pluggy?.type === 'CREDIT') {
    if (op === 'ESTORNO' || op === 'CASHBACK') return { ...base, role: 'regular', dir: 'in' };
    if (CARD_OPS.has(op) || tx.amount < 0) return { ...base, role: 'card', dir: 'in' };
    return { ...base, role: 'regular', dir: 'out' };
  }
  if (isCardPayment(op, base.desc)) return { ...base, role: 'card', dir: 'out' };
  const dir = tx.type === 'CREDIT' ? 'in' : tx.type === 'DEBIT' ? 'out' : null;
  if (!dir) throw new PluggyError('pluggy: transaction without type');
  if (isInvestmentMove(op, base.desc)) return { ...base, role: 'invest', dir };
  return { ...base, role: 'regular', dir };
}
const CATEGORY_RULES: [RegExp, string][] = [
  [/(openai|chatgpt)/, 'shopping'],
  [/(boticario|beto carrero)/, 'leisure'],
  [/(mercado|supermerc|padaria|hortifruti)/, 'groceries'],
  [/(restaurante|lanchonete|ifood|rappi|pizza|burger|mcdonald)/, 'food'],
  [/(cafe|starbucks|padoca)/, 'cafe'],
  [/(uber|99|cabify|posto|combustivel|gasolina|metro|onibus)/, 'transport'],
  [/(farmacia|drogaria|hospital|clinica|laboratorio)/, 'health'],
  [/(academia|fitness|personal)/, 'sport'],
  [/(netflix|spotify|cinema|show|game|jogo|steam|playstation)/, 'leisure'],
  [/(escola|curso|faculdade|livro|udemy)/, 'education'],
  [/(energia|agua|luz|internet|telefone|celular|condominio|iptu)/, 'bills'],
  [/(aluguel|moveis|leroy|madeira|reforma)/, 'home'],
  [/(passagem|hotel|viagem|airbnb|booking)/, 'travel'],
  [/(loja|magazine|amazon|shopee|mercado livre|renner|zara)/, 'shopping'],
];
/** Learned merchant first, then normalized keyword rules, then the generic category of the kind. */
export function categorizePluggy(state: State, kind: 'income' | 'expense', desc: string): string {
  const f = fold(desc);
  const learned = state.merchants ?? {};
  const byName = Object.entries(learned).find(([k, v]) => k.startsWith(`${kind}|`) && v.name && fold(v.name) === f)?.[1];
  const hit = learned[`${kind}|${f}`]?.cat ?? learned[`${kind}|${desc}`]?.cat ?? byName?.cat;
  if (hit && state.categories.some((c) => c.id === hit)) return hit;
  for (const [re, id] of CATEGORY_RULES) if (re.test(f) && state.categories.some((c) => c.id === id)) return id;
  const fallback = kind === 'income' ? 'other_income' : 'other_expense';
  return state.categories.some((c) => c.id === fallback) ? fallback : state.categories.find((c) => c.kind === kind)?.id ?? '';
}
const currencyOf = (state: State, accountId: string) => state.accounts.find((a) => a.id === accountId)?.currency ?? state.settings.baseCurrency;
function existingLegs(state: State): { legs: Leg[]; manualTxs: Tx[]; manualTransfers: Transfer[] } {
  const legs: Leg[] = [];
  const manualTxs: Tx[] = [];
  const manualTransfers: Transfer[] = [];
  for (const tx of state.txs) {
    if (!tx.pluggy) {
      manualTxs.push(tx);
      continue;
    }
    legs.push({ apiId: tx.pluggy.apiId, txId: tx.pluggy.txId, accountId: tx.accountId, currency: currencyOf(state, tx.accountId), cents: tx.amount, date: tx.date, op: tx.pluggy.op, desc: tx.note, role: 'regular', dir: tx.kind === 'income' ? 'in' : 'out' });
  }
  for (const tr of state.transfers) {
    if (!tr.pluggy) {
      manualTransfers.push(tr);
      continue;
    }
    const kind = tr.pluggy.kind ?? 'regular';
    legs.push({ apiId: tr.pluggy.fromApiId, txId: tr.pluggy.fromTxId, accountId: tr.from, currency: currencyOf(state, tr.from), cents: tr.fromAmount, date: tr.pluggy.fromDate, op: '', desc: tr.note, role: kind, dir: 'out' });
    legs.push({ apiId: tr.pluggy.toApiId, txId: tr.pluggy.toTxId, accountId: tr.to, currency: currencyOf(state, tr.to), cents: tr.toAmount, date: tr.pluggy.toDate, op: '', desc: tr.note, role: kind, dir: 'in' });
  }
  for (const conn of state.pluggy ?? []) {
    for (const p of conn.pending ?? []) legs.push({ ...p, currency: p.currency || currencyOf(state, p.accountId) });
  }
  return { legs, manualTxs, manualTransfers };
}
/** Global pairing: one use per leg, closest dates first, deterministic tie-break by composite key. */
export function pairLegs(legs: Leg[]): { pairs: { a: Leg; b: Leg; kind: LegRole }[]; singles: Leg[] } {
  const used = new Set<Leg>();
  const pairs: { a: Leg; b: Leg; kind: LegRole }[] = [];
  const order = (l: Leg) => `${l.date}|${l.apiId}|${l.txId}`;
  const sorted = [...legs].sort((x, y) => order(x).localeCompare(order(y)));
  for (const kind of ['card', 'regular', 'invest'] as LegRole[]) {
    const outs = sorted.filter((l) => l.role === kind && l.dir === 'out' && !used.has(l));
    const ins = sorted.filter((l) => l.role === kind && l.dir === 'in' && !used.has(l));
    const cands: { a: Leg; b: Leg; d: number }[] = [];
    for (const a of outs) {
      for (const b of ins) {
        if (a.accountId === b.accountId || a.currency !== b.currency || a.cents !== b.cents) continue;
        if (kind === 'regular' && !(isTransferLike(a.op, a.desc) && isTransferLike(b.op, b.desc))) continue;
        const d = Math.abs(dayDiff(a.date, b.date));
        if (d <= (kind === 'card' ? 3 : 1)) cands.push({ a, b, d });
      }
    }
    cands.sort((x, y) => x.d - y.d || order(x.a).localeCompare(order(y.a)) || order(x.b).localeCompare(order(y.b)));
    for (const c of cands) {
      if (used.has(c.a) || used.has(c.b)) continue;
      used.add(c.a);
      used.add(c.b);
      pairs.push({ a: c.a, b: c.b, kind });
    }
  }
  return { pairs, singles: sorted.filter((l) => !used.has(l)) };
}
const cleanName = (v?: string) => (typeof v === 'string' ? v.trim() : '');
const fallbackName = (item: PluggyItem, conn: PluggyConn) => cleanName(item.name) || cleanName(item.institution) || cleanName(conn.name) || 'Conta Pluggy';
const legacyAutoName = (item: PluggyItem, conn: PluggyConn): string => {
  const label = item.name || item.institution || conn.name;
  return label && fold(label) !== fold(conn.name) ? `${label} · ${conn.name}` : conn.name;
};
function ensureAccount(state: State, conn: PluggyConn, item: PluggyItem, remote: PluggyAccount): { state: State; account: Account } {
  const found = state.accounts.find((a) => a.pluggy?.apiId === conn.id && a.pluggy.accountId === remote.id);
  const remoteName = cleanName(remote.name);
  if (found) {
    if (!remoteName) return { state, account: found };
    const pg = found.pluggy!;
    if (pg.nameCustomized) return { state, account: found };
    let account: Account;
    if (pg.lastAutoName !== undefined) {
      if (found.name !== pg.lastAutoName) account = { ...found, pluggy: { ...pg, nameCustomized: true } };
      else account = { ...found, name: remoteName, pluggy: { ...pg, lastAutoName: remoteName } };
    } else if (found.name !== legacyAutoName(item, conn)) {
      account = { ...found, pluggy: { ...pg, nameCustomized: true } };
    } else {
      account = { ...found, name: remoteName, pluggy: { ...pg, lastAutoName: remoteName } };
    }
    return { state: { ...state, accounts: state.accounts.map((a) => (a.id === account.id ? account : a)) }, account };
  }
  const id = `pg-${conn.id}-${remote.id}`;
  if (state.accounts.some((a) => a.id === id)) throw new PluggyError('pluggy: account id collision');
  const name = remoteName || fallbackName(item, conn);
  const account: Account = {
    id,
    name,
    icon: remote.type === 'CREDIT' ? 'cards' : 'bank',
    color: remote.type === 'CREDIT' ? '#B57BFF' : '#3D8BFF',
    currency: remote.currencyCode,
    initial: 0,
    includeInTotal: true,
    archived: false,
    order: state.accounts.length,
    pluggy: { apiId: conn.id, accountId: remote.id, type: remote.type, lastAutoName: name },
  };
  return { state: { ...state, accounts: [...state.accounts, account] }, account };
}

const patchConn = (state: State, id: string, patch: Partial<PluggyConn>): State => ({ ...state, pluggy: (state.pluggy ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c)) });
function txFromLeg(leg: Leg, state: State, existing: Map<string, Tx>): Tx {
  const kind: 'income' | 'expense' = leg.dir === 'in' ? 'income' : 'expense';
  const prev = existing.get(legKey(leg.apiId, leg.txId));
  return {
    id: prev?.id ?? `pgtx-${leg.apiId}-${leg.txId}`,
    kind,
    accountId: leg.accountId,
    categoryId: prev?.categoryId ?? categorizePluggy(state, kind, leg.desc),
    amount: leg.cents,
    base: toBase(state, leg.cents, currencyOf(state, leg.accountId)),
    date: leg.date,
    note: prev?.note ?? leg.desc,
    tags: prev?.tags ?? [],
    created: prev?.created ?? `${leg.date}T12:00:00.000Z`,
    pluggy: { apiId: leg.apiId, txId: leg.txId, op: leg.op },
  };
}
function transferFromPair(pair: { a: Leg; b: Leg; kind: LegRole }): Transfer {
  const { a, b, kind } = pair;
  return {
    id: `pgtr-${a.apiId}-${a.txId}-${b.apiId}-${b.txId}`,
    from: a.accountId,
    to: b.accountId,
    fromAmount: a.cents,
    toAmount: b.cents,
    date: a.date,
    note: a.desc || b.desc || 'Pluggy',
    created: `${a.date}T12:00:00.000Z`,
    pluggy: { fromApiId: a.apiId, fromTxId: a.txId, fromDate: a.date, toApiId: b.apiId, toTxId: b.txId, toDate: b.date, kind },
  };
}
/** `initial = target - (balances - initial)`, using the real balance including manual and done entries. */
function reconcile(state: State, targets: Map<string, number>): State {
  const bal = balances(state);
  let accounts = state.accounts;
  for (const [id, target] of targets) {
    const acc = accounts.find((a) => a.id === id);
    if (!acc) continue;
    const initial = target - ((bal.get(id) ?? 0) - acc.initial);
    accounts = accounts.map((a) => (a.id === id ? { ...a, initial } : a));
  }
  return { ...state, accounts };
}
interface Folder {
  item: PluggyItem;
  acc: PluggyAccount;
  txs: PluggyTx[];
}
function applyFetched(state: State, conn: PluggyConn, folders: Folder[], now: number): State {
  let next = state;
  const existing = new Map<string, Tx>();
  for (const tx of next.txs) if (tx.pluggy) existing.set(legKey(tx.pluggy.apiId, tx.pluggy.txId), tx);
  const { legs, manualTxs, manualTransfers } = existingLegs(next);
  const byKey = new Map<string, Leg>();
  for (const leg of legs) byKey.set(legKey(leg.apiId, leg.txId), leg);
  const targets = new Map(balances(state));
  const accountSync = { ...(state.pluggy ?? []).find((c) => c.id === conn.id)?.accountSync };
  for (const f of folders) {
    const created = ensureAccount(next, conn, f.item, f.acc);
    next = created.state;
    const account = created.account;
    targets.set(account.id, f.acc.type === 'CREDIT' ? -Math.round(Math.abs(f.acc.balance) * 100) : Math.round(f.acc.balance * 100));
    for (const t of f.txs) {
      const leg = normalizeLeg(conn.id, account, t);
      if (leg) byKey.set(legKey(leg.apiId, leg.txId), leg);
    }
    accountSync[`${conn.id}|${f.acc.id}`] = new Date(now).toISOString().slice(0, 10);
  }
  const { pairs, singles } = pairLegs([...byKey.values()]);
  const txs = [...manualTxs];
  for (const leg of singles) if (leg.role === 'regular') txs.push(txFromLeg(leg, next, existing));
  const transfers = [...manualTransfers, ...pairs.map(transferFromPair)];
  const keep = singles.filter((l) => l.role !== 'regular' && Date.parse(l.date) >= now - 60 * 864e5);
  const pluggy = (next.pluggy ?? []).map((c) => ({
    ...c,
    pending: keep.filter((l) => l.apiId === c.id).map((l) => ({ apiId: l.apiId, txId: l.txId, accountId: l.accountId, currency: l.currency, cents: l.cents, date: l.date, op: l.op, desc: l.desc, role: l.role as 'card' | 'invest', dir: l.dir })),
  }));
  next = { ...next, txs, transfers, pluggy };
  return reconcile(patchConn(next, conn.id, { accountSync }), targets);
}
export interface SyncOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}
export type ApplyState = (fn: (s: State) => State) => void;
export interface SyncResult {
  ok: boolean;
  added: number;
  errors: string[];
}
interface SourceConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  itemIds: string[];
}
interface Collected {
  connId: string;
  source: SourceConfig;
  folders: Folder[];
  stamps: Record<string, string>;
  errors: string[];
}
const sourceConfig = (conn: PluggyConn): SourceConfig => ({
  clientId: conn.clientId,
  clientSecret: conn.clientSecret,
  baseUrl: conn.baseUrl,
  itemIds: [...conn.itemIds],
});
const normBase = (baseUrl: string) => (baseUrl || PLUGGY_BASE_URL).trim().replace(/\/+$/, '');
function sameConfig(conn: PluggyConn, source: SourceConfig): boolean {
  return conn.clientId === source.clientId
    && conn.clientSecret === source.clientSecret
    && normBase(conn.baseUrl) === normBase(source.baseUrl)
    && conn.itemIds.length === source.itemIds.length
    && conn.itemIds.every((id, i) => id === source.itemIds[i]);
}
let queue: Promise<unknown> = Promise.resolve();
/** One queue for manual, maintenance and timer: fetches never apply snapshots concurrently. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.then(() => undefined, () => undefined);
  return p;
}
function safeError(e: unknown, secret: string): string {
  return redactSecret(e instanceof Error ? e.message : String(e), secret).slice(0, 200);
}
function checkpoint(conn: PluggyConn, accountId: string, now: number): string {
  const saved = conn.accountSync?.[`${conn.id}|${accountId}`];
  if (saved && Number.isFinite(Date.parse(saved))) return addDays(saved.slice(0, 10), -1);
  return new Date(now - 365 * 864e5).toISOString().slice(0, 10);
}
/** Fetches every item/account of one connection without touching State. */
async function collectPluggy(conn: PluggyConn, opts: SyncOptions): Promise<Collected> {
  const folders: Folder[] = [];
  const stamps: Record<string, string> = {};
  const errors: string[] = [];
  const base = { connId: conn.id, source: sourceConfig(conn), folders, stamps, errors };
  if (!conn.enabled || !conn.clientId || !conn.clientSecret || !conn.itemIds.length) {
    errors.push('pluggy: incomplete connection');
    return base;
  }
  const now = opts.now?.() ?? Date.now();
  let client: PluggyClient;
  try {
    client = new PluggyClient(conn, { fetchImpl: opts.fetchImpl });
    await client.auth();
  } catch (e) {
    errors.push(safeError(e, conn.clientSecret));
    return base;
  }
  for (const itemId of conn.itemIds) {
    try {
      const item = await client.item(itemId);
      const accounts = await client.accounts(itemId);
      let itemOk = accounts.length > 0;
      const itemFolders: Folder[] = [];
      for (const acc of accounts) {
        try {
          const txs = await client.transactions(acc.id, checkpoint(conn, acc.id, now));
          itemFolders.push({ item, acc, txs });
        } catch (e) {
          itemOk = false;
          errors.push(safeError(e, conn.clientSecret));
        }
      }
      folders.push(...itemFolders);
      const stamp = itemStamp(item);
      if (itemOk && stamp) stamps[itemId] = stamp;
    } catch (e) {
      errors.push(safeError(e, conn.clientSecret));
    }
  }
  return base;
}
/** Applies collected data to the latest State, preserving local edits and other sync results. */
export function commitPluggy(current: State, collected: Collected, now: number): State {
  const conn = (current.pluggy ?? []).find((c) => c.id === collected.connId);
  if (!conn || !conn.enabled || !sameConfig(conn, collected.source)) return current;
  const allowed = new Set(conn.itemIds);
  const folders = collected.folders.filter((f) => allowed.has(f.item.id));
  let next = current;
  let added = 0;
  if (folders.length) {
    const before = next.txs.length;
    next = applyFetched(next, conn, folders, now);
    added = Math.max(0, next.txs.length - before);
  }
  const currentStamps = next.pluggy?.find((c) => c.id === conn.id)?.itemUpdatedAt ?? {};
  const stamps = Object.fromEntries(Object.entries(collected.stamps).filter(([id]) => allowed.has(id)));
  const ok = collected.errors.length === 0;
  return patchConn(next, conn.id, {
    lastStatus: ok ? 'ok' : 'error',
    lastError: ok ? undefined : collected.errors[0],
    lastCount: added,
    itemUpdatedAt: { ...currentStamps, ...stamps },
    ...(ok ? { lastSyncAt: new Date(now).toISOString() } : {}),
  });
}
/** Manual path: collect first, then commit atomically through the store's latest state. */
export async function syncPluggyVia(get: () => State, apply: ApplyState, connId?: string, opts: SyncOptions = {}): Promise<SyncResult> {
  return serial(async () => {
    const snapshot = get();
    const conns = connId
      ? (snapshot.pluggy ?? []).filter((c) => c.id === connId)
      : (snapshot.pluggy ?? []).filter((c) => c.enabled);
    const errors: string[] = [];
    let added = 0;
    for (const conn of conns) {
      const collected = await collectPluggy(conn, opts);
      const now = opts.now?.() ?? Date.now();
      let discarded = false;
      let failure: string | undefined;
      apply((current) => {
        try {
          const next = commitPluggy(current, collected, now);
          if (next === current) discarded = true;
          return next;
        } catch (e) {
          failure = safeError(e, conn.clientSecret);
          return current;
        }
      });
      if (failure) {
        errors.push(failure);
        continue;
      }
      if (discarded) {
        errors.push('pluggy: configuration changed during sync');
        continue;
      }
      errors.push(...collected.errors);
      added += collected.folders.reduce((n, f) => n + f.txs.length, 0);
    }
    return { ok: errors.length === 0, added, errors };
  });
}
/** Connection test: authenticates and validates itemIds/accounts without importing anything. */
export async function testPluggyConn(conn: PluggyConn, opts: SyncOptions = {}): Promise<{ ok: boolean; error?: string }> {
  if (!conn.clientId || !conn.clientSecret || !conn.itemIds.length) return { ok: false, error: 'pluggy: incomplete connection' };
  try {
    const client = new PluggyClient(conn, { fetchImpl: opts.fetchImpl });
    await client.auth();
    for (const itemId of conn.itemIds) {
      await client.item(itemId);
      await client.accounts(itemId);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: safeError(e, conn.clientSecret) };
  }
}
export const DAY_MS = 24 * 60 * 60 * 1000;
export const PROBE_COOLDOWN_MS = 15 * 60 * 1000;
export function syncDue(conn: PluggyConn, now: number): boolean {
  const t = conn.lastSyncAt ? Date.parse(conn.lastSyncAt) : NaN;
  return !Number.isFinite(t) || now - t >= DAY_MS;
}
export function probeDue(conn: PluggyConn, now: number): boolean {
  const t = conn.lastProbeAt ? Date.parse(conn.lastProbeAt) : NaN;
  return !Number.isFinite(t) || now - t >= PROBE_COOLDOWN_MS;
}
/** First valid timestamp among lastUpdatedAt and updatedAt; never assume a change. */
export function itemStamp(item: PluggyItem): string | undefined {
  return [item.lastUpdatedAt, item.updatedAt].find(
    (raw): raw is string => typeof raw === 'string' && Number.isFinite(Date.parse(raw)),
  );
}
/** 24h check plus light probe; commits through the same atomic path as the manual sync. */
export async function autoSyncPluggyVia(get: () => State, apply: ApplyState, opts: SyncOptions = {}): Promise<{ changed: boolean }> {
  return serial(async () => {
    const now = opts.now?.() ?? Date.now();
    let changed = false;
    const conns = [...(get().pluggy ?? [])];
    for (const conn of conns) {
      if (!conn.auto || !conn.enabled || !conn.clientId || !conn.clientSecret || !conn.itemIds.length) continue;
      if (syncDue(conn, now)) {
        if (conn.lastStatus === 'error' && !probeDue(conn, now)) continue;
        const collected = await collectPluggy(conn, opts);
        const ok = collected.errors.length === 0;
        const source = sourceConfig(conn);
        let discarded = false;
        let failed = false;
        apply((current) => {
          const currentConn = (current.pluggy ?? []).find((c) => c.id === conn.id);
          if (!currentConn || !currentConn.enabled || !sameConfig(currentConn, source)) {
            discarded = true;
            return current;
          }
          try {
            const committed = commitPluggy(current, collected, now);
            return ok ? committed : patchConn(committed, conn.id, { lastProbeAt: new Date(now).toISOString() });
          } catch {
            failed = true;
            return current;
          }
        });
        if (!discarded && !failed) changed = true;
        continue;
      }
      if (!probeDue(conn, now)) continue;
      let newer = false;
      let probeError: string | undefined;
      try {
        const client = new PluggyClient(conn, { fetchImpl: opts.fetchImpl });
        await client.auth();
        for (const itemId of conn.itemIds) {
          try {
            const stamp = itemStamp(await client.item(itemId));
            const saved = conn.itemUpdatedAt?.[itemId];
            const savedTime = saved ? Date.parse(saved) : NaN;
            if (stamp && (!Number.isFinite(savedTime) || Date.parse(stamp) > savedTime)) newer = true;
          } catch (e) {
            probeError = safeError(e, conn.clientSecret);
          }
        }
      } catch (e) {
        probeError = safeError(e, conn.clientSecret);
      }
      const source = sourceConfig(conn);
      let applied = false;
      apply((current) => {
        const currentConn = (current.pluggy ?? []).find((c) => c.id === conn.id);
        if (!currentConn || !currentConn.enabled || !sameConfig(currentConn, source)) return current;
        applied = true;
        return patchConn(current, conn.id, {
          lastProbeAt: new Date(now).toISOString(),
          ...(probeError ? { lastStatus: 'error' as const, lastError: probeError } : {}),
        });
      });
      if (!applied) continue;
      changed = true;
      if (newer) {
        const collected = await collectPluggy(conn, opts);
        apply((current) => {
          const live = (current.pluggy ?? []).find((c) => c.id === conn.id);
          if (!live || !live.enabled || !sameConfig(live, collected.source)) return current;
          try {
            return commitPluggy(current, collected, now);
          } catch (e) {
            return patchConn(current, conn.id, {
              lastStatus: 'error',
              lastError: safeError(e, conn.clientSecret),
              lastProbeAt: new Date(now).toISOString(),
            });
          }
        });
      }
    }
    return { changed };
  });
}
let autoTimer: ReturnType<typeof setInterval> | undefined;
/** Single periodic timer; calling it again replaces the previous one instead of duplicating it. */
export function startPluggyAutoSync(get: () => State, apply: ApplyState, opts: SyncOptions & { intervalMs?: number } = {}): () => void {
  if (autoTimer) clearInterval(autoTimer);
  const tick = () => {
    autoSyncPluggyVia(get, apply, opts).catch(() => { /* isolated per connection */ });
  };
  autoTimer = setInterval(tick, opts.intervalMs ?? PROBE_COOLDOWN_MS);
  return () => {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = undefined;
  };
}
