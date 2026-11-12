import type { Account, State, Tx } from './types';
import { today } from './calc';

export type MonthlyStatus = 'fresh' | 'stale' | 'error' | 'missing' | 'negative';

export interface MonthlyCardRow {
  accountId: string;
  name: string;
  currency: string;
  amount: number | null; // native account currency; null = unknown, never an invented zero
  status: MonthlyStatus;
  source: 'bill' | 'manual';
  includeInTotal: boolean;
  fetchedAt?: string;
}

export interface MonthlyProjection {
  month: string;
  currency: string;
  income: number;
  expense: number;
  net: number;
  cardExpense: number;
  complete: boolean;
  stale: boolean;
  staleAt?: string;
  cards: MonthlyCardRow[];
}

const isPluggyCard = (a: Account) => a.pluggy?.type === 'CREDIT';
const isManualCard = (a: Account) => !a.pluggy && a.icon === 'cards';
const isCard = (a: Account) => isPluggyCard(a) || isManualCard(a);

function rateTo(state: State, from: string, to: string): number | null {
  if (from === to) return 1;
  const base = state.settings.baseCurrency;
  const fromBase = from === base ? 1 : state.settings.rates[from];
  const toBase = to === base ? 1 : state.settings.rates[to];
  if (!Number.isFinite(fromBase) || fromBase <= 0 || !Number.isFinite(toBase) || toBase <= 0) return null;
  return (fromBase as number) / (toBase as number);
}

export function convert(state: State, cents: number, from: string, to: string): number | null {
  const rate = rateTo(state, from, to);
  if (rate === null) return null;
  const value = Math.round(cents * rate);
  return Number.isSafeInteger(value) ? value : null;
}

export const safeAdd = (a: number, b: number): number | null => {
  const value = a + b;
  return Number.isSafeInteger(value) ? value : null;
};
function txSum(txs: Tx[], accountId: string, month: string, selected: boolean) {
  let income = 0;
  let expense = 0;
  for (const tx of txs) {
    if (tx.accountId !== accountId || tx.date.slice(0, 7) !== month) continue;
    const value = selected ? tx.amount : tx.base;
    const next = safeAdd(tx.kind === 'income' ? income : expense, value);
    if (next === null) return { income: 0, expense: 0, overflow: true };
    if (tx.kind === 'income') income = next;
    else expense = next;
  }
  return { income, expense, overflow: false };
}

function pluggyCard(state: State, a: Account, month: string) {
  const cache = a.pluggy?.bills;
  if (!cache) return { native: null, base: null, status: 'missing' as MonthlyStatus, nativeKnown: false, baseKnown: false, fresh: false, fetchedAt: undefined };
  const items = cache.items.filter((b) => b.dueDate.slice(0, 10).slice(0, 7) === month);
  if (!items.length) return { native: null, base: null, status: 'missing' as MonthlyStatus, nativeKnown: false, baseKnown: false, fresh: cache.status === 'fresh', fetchedAt: cache.fetchedAt };
  let native = 0;
  let base = 0;
  let nativeKnown = true;
  let baseKnown = true;
  let negative = false;
  let status: MonthlyStatus = cache.status === 'fresh' ? 'fresh' : cache.status;
  for (const b of items) {
    if (b.amountCents < 0) {
      negative = true;
      continue;
    }
    if (b.currency === a.currency) {
      const next = safeAdd(native, b.amountCents);
      if (next === null) nativeKnown = false;
      else native = next;
    } else {
      const value = convert(state, b.amountCents, b.currency, a.currency);
      if (value === null) nativeKnown = false;
      else {
        const next = safeAdd(native, value);
        if (next === null) nativeKnown = false;
        else native = next;
      }
    }
    if (b.currency === state.settings.baseCurrency) {
      const next = safeAdd(base, b.amountCents);
      if (next === null) baseKnown = false;
      else base = next;
    } else {
      const value = convert(state, b.amountCents, b.currency, state.settings.baseCurrency);
      if (value === null) baseKnown = false;
      else {
        const next = safeAdd(base, value);
        if (next === null) baseKnown = false;
        else base = next;
      }
    }
  }
  if (negative) status = 'negative';
  else if (!nativeKnown) status = 'error';
  else status = cache.status;
  return {
    native: nativeKnown ? native : null,
    base: baseKnown ? base : null,
    status,
    nativeKnown,
    baseKnown,
    fresh: cache.status === 'fresh',
    fetchedAt: cache.fetchedAt,
  };
}

function manualCard(_state: State, a: Account, txs: Tx[], month: string) {
  const sums = txSum(txs, a.id, month, true);
  if (sums.overflow) return { native: null, base: null, status: 'error' as MonthlyStatus, nativeKnown: false, baseKnown: false, fresh: false, fetchedAt: undefined };
  const native = sums.expense - sums.income;
  if (!Number.isSafeInteger(native)) return { native: null, base: null, status: 'error' as MonthlyStatus, nativeKnown: false, baseKnown: false, fresh: false, fetchedAt: undefined };
  const base = convert(_state, native, a.currency, _state.settings.baseCurrency);
  return { native, base, status: 'fresh' as MonthlyStatus, nativeKnown: true, baseKnown: base !== null, fresh: true, fetchedAt: undefined };
}

/** Pure monthly projection: bills by due date, no balance/initial mutation. */
export function monthlyProjection(state: State, accountId?: string, day = today()): MonthlyProjection {
  const month = day.slice(0, 7);
  const selected = accountId ? state.accounts.find((a) => a.id === accountId && !a.archived) : undefined;
  const cardsScope = selected
    ? (isCard(selected) ? [selected] : [])
    : state.accounts.filter((a) => !a.archived && isCard(a));
  const txAccounts = selected
    ? (isCard(selected) ? [] : [selected])
    : state.accounts.filter((a) => !a.archived && a.includeInTotal && !isCard(a));
  let income = 0;
  let expense = 0;
  let complete = true;
  for (const a of txAccounts) {
    const sums = txSum(state.txs, a.id, month, !!selected);
    if (sums.overflow) {
      complete = false;
      continue;
    }
    income += sums.income;
    expense += sums.expense;
  }
  if (!Number.isSafeInteger(income) || !Number.isSafeInteger(expense)) {
    income = 0;
    expense = 0;
    complete = false;
  }

  let stale = false;
  let staleAt: string | undefined;
  let cardExpense = 0;
  const cards: MonthlyCardRow[] = [];
  for (const a of cardsScope) {
    const result = isPluggyCard(a) ? pluggyCard(state, a, month) : manualCard(state, a, state.txs, month);
    const included = selected ? true : a.includeInTotal;
    const oldCache = a.pluggy?.bills;
    const staleRow = !!oldCache && oldCache.status !== 'fresh' && oldCache.items.length > 0;
    if (included && staleRow) {
      stale = true;
      if (oldCache.fetchedAt && (!staleAt || oldCache.fetchedAt > staleAt)) staleAt = oldCache.fetchedAt;
    }
    cards.push({
      accountId: a.id,
      name: a.name,
      currency: a.currency,
      amount: result.native,
      status: result.status,
      source: isPluggyCard(a) ? 'bill' : 'manual',
      includeInTotal: a.includeInTotal,
      fetchedAt: result.fetchedAt,
    });
    if (!included) continue;
    if (selected) {
      if (result.nativeKnown && result.status !== 'missing' && result.status !== 'negative') {
        const next = safeAdd(expense, result.native as number);
        if (next === null) complete = false;
        else {
          expense = next;
          cardExpense = next;
        }
        if (!result.fresh) complete = false;
      } else complete = false;
    } else {
      if (result.baseKnown && result.status !== 'missing' && result.status !== 'negative') {
        const next = safeAdd(expense, result.base as number);
        if (next === null) complete = false;
        else {
          expense = next;
          cardExpense += result.base as number;
          if (!Number.isSafeInteger(cardExpense)) complete = false;
        }
        if (!result.fresh) complete = false;
      } else complete = false;
    }
  }
  const net = income - expense;
  if (!Number.isSafeInteger(net)) complete = false;
  return {
    month,
    currency: selected ? selected.currency : state.settings.baseCurrency,
    income,
    expense,
    net: Number.isSafeInteger(net) ? net : 0,
    cardExpense,
    complete,
    stale,
    staleAt,
    cards,
  };
}
