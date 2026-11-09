import JSZip from 'jszip';
import { SqliteFile, Row } from './sqlite';
import { LEGACY_ICON } from './icons';
import type { Account, Category, State, Transfer, Tx } from './types';
import { defaultSettings } from './defaults';

const argbToHex = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '#7C5CFF';
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0').toUpperCase();
};
const mapIcon = (s: unknown) => LEGACY_ICON[String(s)] ?? 'question';
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Read a .mmbackup (zip with an SQLite database) or the raw .db and convert it to our state. */
export async function importMmBackup(data: ArrayBuffer | Uint8Array, prev?: State): Promise<{ state: State; report: ImportReport; files: Map<string, Blob> }> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let dbBytes: Uint8Array | null = null;
  let zip: JSZip | null = null;
  if (bytes[0] === 0x53 && bytes[1] === 0x51) dbBytes = bytes; // "SQ"
  else {
    // zip may have extra data prepended; find the first local header
    let start = 0;
    for (let i = 0; i < Math.min(bytes.length - 4, 1 << 20); i++) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) { start = i; break; }
    }
    zip = await JSZip.loadAsync(start ? bytes.subarray(start) : bytes);
    const entry = Object.values(zip.files).find((f) => !f.dir && /\.(db|sqlite)$/i.test(f.name));
    if (!entry) throw new Error('NO_DB');
    dbBytes = await entry.async('uint8array');
  }
  const db = new SqliteFile(dbBytes);
  const out = convert(db, prev);
  // photos attached to transactions
  const files = new Map<string, Blob>();
  if (zip) {
    const fileRows = new Map(db.all('sync_file').filter((r) => !Number(r.isRemoved)).map((r) => [String(r.uid), String(r.localPath ?? '')]));
    const photoLinks = db.all('sync_link').filter((l) => !Number(l.isRemoved) && l.entityType === 'Transaction' && l.otherType === 'Photo');
    const byTx = new Map(out.state.txs.map((t) => [t.id, t]));
    for (const l of photoLinks) {
      const tx = byTx.get(String(l.entityUid));
      const local = fileRows.get(String(l.otherUid));
      if (!tx || !local) continue;
      const entry = Object.values(zip.files).find((f) => f.name.endsWith(local));
      if (!entry) continue;
      const data = await entry.async('uint8array');
      const type = /\.png$/i.test(local) ? 'image/png' : /\.pdf$/i.test(local) ? 'application/pdf' : 'image/jpeg';
      const id = 'att-' + String(l.otherUid);
      files.set(id, new Blob([new Uint8Array(data)], { type }));
      tx.attachments = [...(tx.attachments ?? []), { id, name: local, type, size: data.length }];
    }
  }
  return { ...out, files };
}

export interface ImportReport {
  accounts: number;
  categories: number;
  txs: number;
  transfers: number;
}

function convert(db: SqliteFile, prev?: State): { state: State; report: ImportReport } {
  const live = (r: Row) => !Number(r.isRemoved);
  const settings = { ...(prev?.settings ?? defaultSettings()) };

  const syncSettings = Object.fromEntries(db.all('syncable_settings').map((r) => [r.uid, r.value]));
  const base = String(syncSettings.defaultCurrencyCode ?? settings.baseCurrency ?? 'BRL');
  settings.baseCurrency = base;

  const profile = Object.fromEntries(db.all('user_profile').map((r) => [r.key, r.value]));
  if (profile.fullName) settings.name = String(profile.fullName).split(' ')[0];

  // rates: store value of 1 unit of X in base currency
  const rates: Record<string, number> = { ...settings.rates };
  for (const r of db.all('rates')) {
    const from = String(r.fromCurrencyCode), to = String(r.toCurrencyCode), v = Number(r.value);
    if (!v) continue;
    if (to === base && from !== base) rates[from] = v;
  }
  for (const r of db.all('rates')) {
    const from = String(r.fromCurrencyCode), to = String(r.toCurrencyCode), v = Number(r.value);
    if (from === base && to !== base && !rates[to] && v) rates[to] = 1 / v;
  }
  delete rates[base];
  settings.rates = rates;
  settings.ratesUpdated = new Date().toISOString();

  const links = db.all('sync_link').filter(live);
  const linkMap = new Map<string, Map<string, string[]>>();
  for (const l of links) {
    const key = `${l.entityType}:${l.entityUid}`;
    if (!linkMap.has(key)) linkMap.set(key, new Map());
    const m = linkMap.get(key)!;
    const t = String(l.otherType);
    if (!m.has(t)) m.set(t, []);
    m.get(t)!.push(String(l.otherUid));
  }
  const link = (et: string, id: unknown, ot: string) => linkMap.get(`${et}:${id}`)?.get(ot) ?? [];

  const accRows = db.all('account').filter(live);
  const accounts: Account[] = accRows
    .sort((a, b) => Number(a.position) - Number(b.position))
    .map((r, i) => ({
      id: String(r.uid),
      name: String(r.title ?? ''),
      icon: mapIcon(r.icon),
      color: argbToHex(r.color),
      currency: String(r.currencyCode ?? base),
      initial: 0,
      includeInTotal: !Number(r.ignoreInBalance),
      archived: !Number(r.isActive) || !!Number(r.isArchived),
      order: i,
      note: r.comment ? String(r.comment) : undefined,
    }));
  // active ones first, keeping position order
  accounts.sort((a, b) => Number(a.archived) - Number(b.archived) || a.order - b.order).forEach((a, i) => (a.order = i));
  const accById = new Map(accounts.map((a) => [a.id, a]));

  const categories: Category[] = db
    .all('category')
    .filter(live)
    .sort((a, b) => Number(a.position) - Number(b.position))
    .map((r, i) => ({
      id: String(r.uid),
      name: String(r.title ?? ''),
      kind: String(r.type).toLowerCase() === 'income' ? 'income' : 'expense',
      icon: mapIcon(r.icon),
      color: argbToHex(r.color),
      budget: num(r.limitAmount) || undefined,
      archived: !!Number(r.isArchived),
      order: i,
    }));
  const catIds = new Set(categories.map((c) => c.id));

  const tagNames = new Map(db.all('tag').filter(live).map((t) => [String(t.uid), String(t.name)]));

  const toBase = (amt: number, cur: string) => (cur === base ? amt : Math.round(amt * (rates[cur] ?? 1)));
  const fromBase = (amt: number, cur: string) => (cur === base ? amt : Math.round(amt / (rates[cur] ?? 1)));

  const txs: Tx[] = [];
  for (const r of db.all('transaction').filter(live)) {
    const accountId = link('Transaction', r.uid, 'Account')[0];
    const acc = accById.get(accountId);
    if (!acc) continue;
    let categoryId = link('Transaction', r.uid, 'Category')[0];
    const kind = String(r.type).toLowerCase() === 'income' ? 'income' : 'expense';
    if (!categoryId || !catIds.has(categoryId)) categoryId = kind === 'income' ? 'other_income' : 'other_expense';
    const def = num(r.amountInDefaultCurrency);
    const real = num(r.amountInRealCurrency);
    const accAmt = num(r.amountInAccountCurrency);
    let amount: number;
    if (accAmt !== null && (!r.accountCurrencyCode || r.accountCurrencyCode === acc.currency)) amount = accAmt;
    else if (real !== null && r.realCurrencyCode === acc.currency) amount = real;
    else if (def !== null && acc.currency === base) amount = def;
    else if (def !== null) amount = fromBase(def, acc.currency);
    else amount = real ?? 0;
    const baseAmt = def ?? toBase(amount, acc.currency);
    txs.push({
      id: String(r.uid),
      kind,
      accountId,
      categoryId,
      amount: Math.abs(amount),
      base: Math.abs(baseAmt),
      date: String(r.date).slice(0, 10),
      note: String(r.comment ?? ''),
      tags: link('Transaction', r.uid, 'Tag').map((t) => tagNames.get(t)).filter(Boolean) as string[],
      created: String(r.created ?? r.date),
    });
  }

  const transfers: Transfer[] = [];
  for (const r of db.all('transfer').filter(live)) {
    const from = link('Transfer', r.uid, 'FromAccount')[0];
    const to = link('Transfer', r.uid, 'ToAccount')[0];
    if (!accById.has(from) || !accById.has(to)) continue;
    const fa = Number(r.fromAmount ?? 0);
    const ta = num(r.toAmount) ?? fa;
    transfers.push({
      id: String(r.uid), from, to, fromAmount: fa, toAmount: ta,
      date: String(r.date).slice(0, 10), note: String(r.comment ?? ''), created: String(r.created ?? r.date),
    });
  }

  // Opening balances: reconcile with stored balances so totals match exactly
  const stored = new Map(db.all('account_balance').map((r) => [String(r.uid), Number(r.value ?? 0)]));
  const flow = new Map<string, number>();
  const add = (id: string, v: number) => flow.set(id, (flow.get(id) ?? 0) + v);
  for (const t of txs) add(t.accountId, t.kind === 'income' ? t.amount : -t.amount);
  for (const t of transfers) { add(t.from, -t.fromAmount); add(t.to, t.toAmount); }
  for (const a of accounts) {
    if (stored.has(a.id)) a.initial = stored.get(a.id)! - (flow.get(a.id) ?? 0);
  }

  // make sure fallback categories exist
  for (const [id, kind] of [['other_expense', 'expense'], ['other_income', 'income']] as const) {
    if (!catIds.has(id) && txs.some((t) => t.categoryId === id)) {
      categories.push({ id, name: kind === 'income' ? 'Outros' : 'Outros', kind, icon: 'question', color: '#495057', archived: false, order: categories.length });
    }
  }

  txs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.created < b.created ? 1 : -1));
  transfers.sort((a, b) => (a.date < b.date ? 1 : -1));

  const state: State = { version: 1, accounts, categories, txs, transfers, settings: { ...settings, onboarded: true } };
  return { state, report: { accounts: accounts.length, categories: categories.length, txs: txs.length, transfers: transfers.length } };
}
