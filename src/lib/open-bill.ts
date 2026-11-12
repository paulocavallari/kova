import type { State } from './types';
import { today } from './calc';
import { convert, safeAdd } from './monthly';
import { likelySubscriptions, remainingInstallments } from './forecast';

export interface OpenBillRow {
  accountId: string;
  name: string;
  currency: string;
  cycle: string;
  native: number | null;
  base: number | null;
  count: number;
  status: 'open' | 'partial' | 'negative' | 'error';
  originAt?: string;
  syncedAt?: string;
  syncOk: boolean;
}

const validCycle = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
export function openCycles(state: State, accountId?: string, day = today()): OpenBillRow[] {
  const rows: OpenBillRow[] = [];
  for (const account of state.accounts) {
    if (account.archived || account.pluggy?.type !== 'CREDIT' || (accountId && account.id !== accountId)) continue;
    const published = new Set(account.pluggy.bills?.items.map((bill) => bill.dueDate.slice(0, 7)) ?? []);
    const candidates = state.txs.filter((tx) => {
      const cycle = tx.pluggy?.billForecastDate;
      return tx.accountId === account.id && !tx.pluggy?.billId && !!cycle && validCycle(cycle) && cycle >= day.slice(0, 7) && !published.has(cycle);
    });
    const cycles = [...new Set(candidates.map((tx) => tx.pluggy!.billForecastDate!))].sort();
    const conn = state.pluggy?.find((c) => c.id === account.pluggy!.apiId);
    const origin = account.pluggy.itemId ? conn?.itemUpdatedAt?.[account.pluggy.itemId] : undefined;
    for (const cycle of cycles) {
      const selected = candidates.filter((tx) => tx.pluggy!.billForecastDate === cycle);
      let native: number | null = 0;
      for (const tx of selected) {
        const value = tx.pluggy!.billCents;
        if (value === undefined || !Number.isSafeInteger(value) || native === null) {
          native = null;
          break;
        }
        native = safeAdd(native, tx.kind === 'income' ? -value : value);
      }
      rows.push({
        accountId: account.id, name: account.name, currency: account.currency, cycle, native,
        base: native === null ? null : convert(state, native, account.currency, state.settings.baseCurrency),
        count: selected.length, status: native === null ? 'error' : native < 0 ? 'negative' : account.pluggy.forecastGap ? 'partial' : 'open',
        originAt: origin && Number.isFinite(Date.parse(origin)) ? origin : undefined,
        syncedAt: conn?.lastSyncAt, syncOk: conn?.lastStatus !== 'error',
      });
    }
  }
  return rows;
}
export function openBills(state: State, accountId?: string, day = today()): OpenBillRow[] {
  const seen = new Set<string>();
  return openCycles(state, accountId, day).filter((row) => {
    if (seen.has(row.accountId)) return false;
    seen.add(row.accountId);
    return true;
  });
}
export function openMonthLabel(cycle: string, locale: string): string {
  return new Date(cycle + '-01T12:00:00.000Z').toLocaleDateString(locale, { month: 'short' });
}

export interface NextCycleRow {
  accountId: string;
  cycle: string;
  published: { native: number | null; count: number } | null;
  installments?: { cents: number; count: number };
  subscriptions?: { cents: number; count: number };
}
export function nextCycles(state: State, accountId?: string, day = today()): NextCycleRow[] {
  const published = openCycles(state, accountId, day);
  const projected = remainingInstallments(state, accountId, day);
  const rows = new Map<string, NextCycleRow>();
  for (const row of published) {
    rows.set(`${row.accountId}|${row.cycle}`, { accountId: row.accountId, cycle: row.cycle, published: { native: row.native, count: row.count } });
  }
  for (const row of projected) {
    const key = `${row.accountId}|${row.cycle}`;
    const existing = rows.get(key) ?? { accountId: row.accountId, cycle: row.cycle, published: null };
    existing.installments = { cents: row.cents, count: row.count };
    rows.set(key, existing);
  }
  for (const row of likelySubscriptions(state, accountId, day)) {
    const key = `${row.accountId}|${row.cycle}`;
    const existing = rows.get(key) ?? { accountId: row.accountId, cycle: row.cycle, published: null };
    const prev = existing.subscriptions ?? { cents: 0, count: 0 };
    existing.subscriptions = { cents: prev.cents + row.cents, count: prev.count + row.count };
    rows.set(key, existing);
  }
  return [...rows.values()].sort((a, b) => a.cycle.localeCompare(b.cycle) || a.accountId.localeCompare(b.accountId));
}
