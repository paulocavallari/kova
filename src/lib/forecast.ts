import { today } from './calc';
import type { State, Tx } from './types';
import { fold } from './calc';

export interface RemainingRow {
  accountId: string;
  cycle: string;
  cents: number;
  count: number;
}

const TOLERANCE_CENTS = 20;
const TOLERANCE_RATIO = 0.015;
const sameValue = (a: number, b: number) => Math.abs(a - b) <= Math.max(TOLERANCE_CENTS, TOLERANCE_RATIO * Math.max(a, b));

const addCycle = (cycle: string, months: number) => {
  const index = Number(cycle.slice(0, 4)) * 12 + Number(cycle.slice(5, 7)) - 1 + months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};

interface Plan {
  total: number;
  ref: number;
  items: Tx[];
}

function plansOf(txs: Tx[]): Plan[] {
  const plans: Plan[] = [];
  const byPurchase = new Map<string, Plan[]>();
  for (const tx of txs) {
    const pluggy = tx.pluggy!;
    const cents = pluggy.billCents ?? tx.amount;
    const key = `${pluggy.purchaseDate}|${pluggy.totalInstallments}`;
    const group = byPurchase.get(key) ?? [];
    let plan = group.find((candidate) => sameValue(candidate.ref, cents));
    if (!plan) {
      plan = { total: pluggy.totalInstallments!, ref: cents, items: [] };
      group.push(plan);
      byPurchase.set(key, group);
      plans.push(plan);
    }
    plan.items.push(tx);
  }
  return plans;
}

function projectPlan(plan: Plan, cycleOfBill: Map<string, string>): { cycle: string; cents: number }[] {
  const numbers = plan.items.map((tx) => tx.pluggy!.installmentNumber!);
  if (new Set(numbers).size !== numbers.length) return [];
  const last = plan.items.reduce((a, b) => (b.pluggy!.installmentNumber! > a.pluggy!.installmentNumber! ? b : a));
  const lastNumber = last.pluggy!.installmentNumber!;
  if (lastNumber >= plan.total) return [];
  const base = last.pluggy!.billId ? cycleOfBill.get(last.pluggy!.billId) : last.pluggy!.billForecastDate;
  if (!base) return [];
  const cents = last.pluggy!.billCents ?? last.amount;
  return Array.from({ length: plan.total - lastNumber }, (_, i) => ({ cycle: addCycle(base, i + 1), cents }));
}

export function remainingInstallments(state: State, accountId?: string, day = today()): RemainingRow[] {
  const from = day.slice(0, 7);
  const rows = new Map<string, RemainingRow>();
  for (const account of state.accounts) {
    if (account.archived || account.pluggy?.type !== 'CREDIT' || (accountId && account.id !== accountId)) continue;
    const items = account.pluggy.bills?.items ?? [];
    const cycleOfBill = new Map(items.map((bill) => [bill.id, bill.dueDate.slice(0, 7)]));
    const published = new Set(items.map((bill) => bill.dueDate.slice(0, 7)));
    const txs = state.txs.filter((tx) => tx.accountId === account.id && tx.kind === 'expense' && tx.pluggy?.installmentNumber !== undefined && tx.pluggy.totalInstallments !== undefined && tx.pluggy.purchaseDate !== undefined);
    for (const plan of plansOf(txs)) {
      for (const { cycle, cents } of projectPlan(plan, cycleOfBill)) {
        if (cycle < from || published.has(cycle)) continue;
        const key = `${account.id}|${cycle}`;
        const row = rows.get(key) ?? { accountId: account.id, cycle, cents: 0, count: 0 };
        row.cents += cents;
        row.count += 1;
        rows.set(key, row);
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.cycle.localeCompare(b.cycle) || a.accountId.localeCompare(b.accountId));
}

export interface SubscriptionRow {
  accountId: string;
  cycle: string;
  cents: number;
  count: number;
}

const normalizeMerchant = (note: string) => {
  const f = fold(note).replace(/"/g, '');
  const i = f.indexOf('*');
  return (i >= 0 ? f.slice(i + 1) : f).replace(/\s+/g, ' ').trim();
};

export function likelySubscriptions(state: State, accountId?: string, day = today()): SubscriptionRow[] {
  const current = day.slice(0, 7);
  const rows: SubscriptionRow[] = [];
  for (const account of state.accounts) {
    if (account.archived || account.pluggy?.type !== 'CREDIT' || (accountId && account.id !== accountId)) continue;
    const series = new Map<string, Map<string, number>>();
    for (const tx of state.txs) {
      const pluggy = tx.pluggy;
      if (tx.accountId !== account.id || tx.kind !== 'expense' || !pluggy?.billForecastDate || pluggy.installmentNumber !== undefined) continue;
      const key = `${normalizeMerchant(tx.note)}|${pluggy.billCents ?? tx.amount}`;
      const byCycle = series.get(key) ?? new Map<string, number>();
      byCycle.set(pluggy.billForecastDate, (byCycle.get(pluggy.billForecastDate) ?? 0) + 1);
      series.set(key, byCycle);
    }
    const published = new Set((account.pluggy.bills?.items ?? []).map((bill) => bill.dueDate.slice(0, 7)));
    for (const [key, byCycle] of series) {
      const cycles = [...byCycle.keys()].sort();
      const last = cycles[cycles.length - 1];
      if (last > current || last < addCycle(current, -1)) continue;
      const window = [addCycle(last, -2), addCycle(last, -1), last];
      if (!window.every((c) => byCycle.get(c) === 1)) continue;
      const next = addCycle(last, 1);
      if (published.has(next)) continue;
      rows.push({ accountId: account.id, cycle: next, cents: Number(key.split('|')[1]), count: 1 });
    }
  }
  return rows.sort((a, b) => a.cycle.localeCompare(b.cycle) || a.accountId.localeCompare(b.accountId));
}
