import { addPeriod, today } from './calc';
import { convert, monthlyProjection, safeAdd } from './monthly';
import { nextCycles } from './open-bill';
import type { State, Tx } from './types';

export type OutlookBasis = 'posted' | 'forecast' | 'none';

export interface OutlookRow {
  month: string;
  income: number;
  expense: number;
  cardBills: number;
  cardForecast: number;
  subscriptionsLikely: number;
  net: number;
  basis: OutlookBasis;
  complete: boolean;
}

export interface PurchaseInput {
  amount?: number;
  installments: number;
  firstMonth?: string;
  installmentAmount?: number;
}

export interface SimMonthRow {
  month: string;
  baselineNet: number;
  installment: number;
  newNet: number;
  basis: OutlookBasis;
  complete: boolean;
}

export interface PurchaseSimulation {
  currency: string;
  total: number;
  installments: number;
  firstMonth: string;
  horizonMonths: number;
  months: SimMonthRow[];
  summary: {
    total: number;
    worstMonth: { month: string; newNet: number } | null;
    turnsNegativeMonths: string[];
    alreadyNegativeMonths: string[];
    incompleteMonths: string[];
    baselineBasis: 'commitments';
  };
}

const VALID_YM = /^\d{4}-(0[1-9]|1[0-2])$/;

function addCycle(ym: string, offset: number): string {
  const idx = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + offset;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

function monthDiff(fromYm: string, toYm: string): number {
  return (Number(toYm.slice(0, 4)) - Number(fromYm.slice(0, 4))) * 12 + (Number(toYm.slice(5, 7)) - Number(fromYm.slice(5, 7)));
}

function expandSeries(state: State, endMonth: string): State {
  const latest = new Map<string, Tx>();
  for (const tx of state.txs) {
    if (!tx.series) continue;
    const prev = latest.get(tx.series);
    if (!prev || tx.date > prev.date) latest.set(tx.series, tx);
  }
  const extra: Tx[] = [];
  for (const last of latest.values()) {
    if (!last.repeat) continue;
    for (let step = 1; step <= 600; step++) {
      const nextDate = addPeriod(last.date, last.repeat, step);
      if (nextDate.slice(0, 7) > endMonth) break;
      extra.push({ ...last, id: `syn-${last.series}-${step}`, date: nextDate, done: undefined, attachments: undefined });
    }
  }
  return extra.length ? { ...state, txs: [...state.txs, ...extra] } : state;
}

/** 12-month (or N-month) forward outlook over committed income, bills and forecast. */
export function buildOutlook(state: State, day = today(), months = 12): OutlookRow[] {
  const count = Math.max(1, Math.min(36, Math.floor(months)));
  const start = day.slice(0, 7);
  const end = addCycle(start, count - 1);
  const synth = expandSeries(state, end);
  const cycles = nextCycles(state, undefined, day);
  const cycleMap = new Map(cycles.map((r) => [`${r.accountId}|${r.cycle}`, r]));
  const accMap = new Map(state.accounts.map((a) => [a.id, a]));
  const baseCur = state.settings.baseCurrency;
  const rows: OutlookRow[] = [];

  for (let i = 0; i < count; i++) {
    const month = addCycle(start, i);
    const proj = monthlyProjection(synth, undefined, `${month}-01`);
    const incCards = proj.cards.filter((c) => c.includeInTotal);
    const missingCards = incCards.filter((c) => c.status === 'missing');

    let complete = missingCards.length
      ? !incCards.some((c) => c.status === 'stale' || c.status === 'error' || c.status === 'negative' || (c.status !== 'missing' && c.amount !== null && convert(state, c.amount, c.currency, baseCur) === null))
      : proj.complete;

    let cardForecast = 0;
    let subscriptionsLikely = 0;
    let usedForecast = false;
    let uncoveredMissing = false;

    for (const c of incCards) {
      const row = cycleMap.get(`${c.accountId}|${month}`);
      if (row?.subscriptions) {
        const subBase = convert(state, row.subscriptions.cents, c.currency, baseCur);
        if (subBase !== null) subscriptionsLikely = safeAdd(subscriptionsLikely, subBase) ?? subscriptionsLikely;
      }
      if (c.status !== 'missing') continue;
      if (!row || (row.published === null && !row.installments)) {
        uncoveredMissing = true;
        complete = false;
        continue;
      }
      usedForecast = true;
      if (row.published && (row.published.native === null || accMap.get(c.accountId)?.pluggy?.forecastGap)) {
        complete = false;
      }
      const nativeSum = safeAdd(row.published?.native ?? 0, row.installments?.cents ?? 0);
      const conv = nativeSum === null ? null : convert(state, nativeSum, c.currency, baseCur);
      const added = conv === null ? null : safeAdd(cardForecast, conv);
      if (added === null) complete = false;
      else cardForecast = added;
    }

    const totalExp = safeAdd(proj.expense, cardForecast);
    const expense = totalExp ?? proj.expense;
    if (totalExp === null) complete = false;
    const rawNet = safeAdd(proj.income, -expense);
    const net = rawNet ?? 0;
    if (rawNet === null) complete = false;

    const hasPosted = proj.income > 0 || expense > 0 || incCards.some((c) => c.status !== 'missing');
    const basis: OutlookBasis = uncoveredMissing ? 'none' : usedForecast ? 'forecast' : hasPosted ? 'posted' : 'none';

    rows.push({ month, income: proj.income, expense, cardBills: proj.cardExpense, cardForecast, subscriptionsLikely, net, basis, complete });
  }
  return rows;
}

/** Deterministic installment simulation over the committed monthly outlook (in cents). */
export function simulatePurchase(state: State, input: PurchaseInput, day = today()): PurchaseSimulation | { error: string } {
  const n = input.installments;
  if (!Number.isInteger(n) || n < 1 || n > 120) return { error: 'installments must be between 1 and 120' };

  let total: number;
  let per: number;
  let firstExtra = 0;
  if (input.installmentAmount !== undefined) {
    const inst = input.installmentAmount;
    if (!Number.isSafeInteger(inst) || inst <= 0 || !Number.isSafeInteger(inst * n)) return { error: 'installmentAmount must be a positive integer' };
    per = inst;
    total = inst * n;
  } else {
    const amt = input.amount;
    if (amt === undefined || !Number.isSafeInteger(amt) || amt <= 0) return { error: 'amount must be a positive integer in cents' };
    total = amt;
    per = Math.floor(total / n);
    firstExtra = total % n;
  }

  const current = day.slice(0, 7);
  const firstMonth = input.firstMonth ?? addCycle(current, 1);
  if (!VALID_YM.test(firstMonth)) return { error: 'firstMonth must be YYYY-MM' };
  const offset = monthDiff(current, firstMonth);
  if (offset < 0 || offset > 36) return { error: 'firstMonth must be between current month and +36 months' };

  const horizon = Math.min(36, Math.max(12, offset + n));
  const outlook = buildOutlook(state, day, horizon);
  const months: SimMonthRow[] = [];
  const turnsNegativeMonths: string[] = [];
  const alreadyNegativeMonths: string[] = [];
  const incompleteMonths: string[] = [];
  let worstMonth: { month: string; newNet: number } | null = null;

  for (let i = 0; i < outlook.length; i++) {
    const row = outlook[i];
    const k = i - offset;
    const installment = k >= 0 && k < n ? per + (k === 0 ? firstExtra : 0) : 0;
    const newNet = safeAdd(row.net, -installment) ?? row.net - installment;
    const complete = row.complete && Number.isSafeInteger(newNet);
    months.push({ month: row.month, baselineNet: row.net, installment, newNet, basis: row.basis, complete });
    if (row.net < 0) alreadyNegativeMonths.push(row.month);
    else if (newNet < 0) turnsNegativeMonths.push(row.month);
    if (!complete) incompleteMonths.push(row.month);
    if (!worstMonth || newNet < worstMonth.newNet) worstMonth = { month: row.month, newNet };
  }

  return {
    currency: state.settings.baseCurrency,
    total,
    installments: n,
    firstMonth,
    horizonMonths: horizon,
    months,
    summary: { total, worstMonth, turnsNegativeMonths, alreadyNegativeMonths, incompleteMonths, baselineBasis: 'commitments' },
  };
}
