import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/lib/defaults';
import type { State } from '../src/lib/types';
import { buildOutlook, simulatePurchase } from '../src/lib/outlook';

function baseState(): State {
  const s = initialState('pt');
  return {
    ...s,
    settings: { ...s.settings, baseCurrency: 'BRL', rates: {}, lang: 'pt' },
    pluggy: [{
      id: 'api-1', name: 'Banco Alfa', clientId: 'cid', clientSecret: 'sec',
      itemIds: ['item-1'], baseUrl: 'https://pluggy.example.test', enabled: true, auto: true, lastStatus: 'ok',
    }],
  };
}

function addPluggyCard(s: State, id: string, items: { id: string; dueDate: string; amountCents: number; currency?: string; }[], extra?: { status?: 'fresh' | 'stale' | 'error'; currency?: string; forecastGap?: boolean }) {
  s.accounts.push({
    id, name: 'Cartão Beta', icon: 'cards', color: '#3D8BFF', currency: extra?.currency ?? 'BRL',
    initial: 0, includeInTotal: true, archived: false, order: s.accounts.length,
    pluggy: {
      apiId: 'api-1', accountId: `ext-${id}`, type: 'CREDIT', itemId: 'item-1',
      forecastGap: extra?.forecastGap,
      bills: {
        fetchedAt: '2026-11-10T10:00:00.000Z',
        status: extra?.status ?? 'fresh',
        items: items.map((b) => ({ id: b.id, dueDate: b.dueDate, amountCents: b.amountCents, currency: b.currency ?? 'BRL' })),
      },
    },
  });
}

test('example-guide: monthly income, fixed expense and published bill yield exact baselineNet and 10x simulation', () => {
  const s = baseState();
  addPluggyCard(s, 'card-1', [{ id: 'b1', dueDate: '2026-12-10', amountCents: 120_000 }]);
  s.txs.push(
    { id: 't1', kind: 'income', accountId: 'bank', categoryId: 'salary', amount: 500_000, base: 500_000, date: '2026-11-05', note: 'Salário', tags: [], created: '2026-11-05T00:00:00Z', repeat: 'monthly', series: 'ser-sal' },
    { id: 't2', kind: 'expense', accountId: 'bank', categoryId: 'bills', amount: 150_000, base: 150_000, date: '2026-11-10', note: 'Aluguel', tags: [], created: '2026-11-10T00:00:00Z', repeat: 'monthly', series: 'ser-rent' },
  );

  const sim = simulatePurchase(s, { amount: 300_000, installments: 10 }, '2026-11-12');
  assert.equal('error' in sim, false);
  if ('error' in sim) return;
  const dec = sim.months.find((m) => m.month === '2026-12')!;
  assert.equal(dec.month, '2026-12');
  assert.equal(dec.baselineNet, 230_000);
  assert.equal(dec.installment, 30_000);
  assert.equal(dec.newNet, 200_000);
  assert.equal(dec.basis, 'posted');
  assert.equal(dec.complete, true);
  assert.equal(sim.total, 300_000);
  assert.equal(sim.summary.baselineBasis, 'commitments');
});

test('forecast basis: missing published bill uses nextCycles installments and drops baselineNet', () => {
  const s = baseState();
  addPluggyCard(s, 'card-1', [{ id: 'b1', dueDate: '2026-12-10', amountCents: 100_000 }]);
  s.txs.push(
    { id: 't1', kind: 'income', accountId: 'bank', categoryId: 'salary', amount: 400_000, base: 400_000, date: '2026-11-05', note: 'Salário', tags: [], created: '2026-11-05T00:00:00Z', repeat: 'monthly', series: 'ser-sal' },
    {
      id: 'inst-1', kind: 'expense', accountId: 'card-1', categoryId: 'shopping', amount: 30_000, base: 30_000,
      date: '2026-11-02', note: 'Loja Alfa', tags: [], created: '2026-11-02T00:00:00Z',
      pluggy: { apiId: 'api-1', txId: 'px1', op: 'BUY', billId: 'b1', billCents: 30_000, installmentNumber: 1, totalInstallments: 3, purchaseDate: '2026-11-01' },
    },
  );

  const out = buildOutlook(s, '2026-11-12', 4);
  const jan = out.find((r) => r.month === '2027-01')!;
  assert.equal(jan.basis, 'forecast');
  assert.equal(jan.cardBills, 0);
  assert.equal(jan.cardForecast, 30_000);
  assert.equal(jan.net, 370_000);
  assert.equal(jan.complete, true);
});

test('basis none: month with missing Pluggy bill and no forecast marks basis none and complete false', () => {
  const s = baseState();
  addPluggyCard(s, 'card-1', [{ id: 'b1', dueDate: '2026-11-10', amountCents: 50_000 }]);
  const out = buildOutlook(s, '2026-11-12', 2);
  assert.equal(out[0].basis, 'posted');
  assert.equal(out[1].basis, 'none');
  assert.equal(out[1].complete, false);
});

test('weekly and yearly recurring series generate future occurrences accurately', () => {
  const s = baseState();
  s.txs.push(
    { id: 'tw', kind: 'expense', accountId: 'bank', categoryId: 'groceries', amount: 10_000, base: 10_000, date: '2026-11-02', note: 'Mercado', tags: [], created: '2026-11-02T00:00:00Z', repeat: 'weekly', series: 'ser-wk' },
    { id: 'ty', kind: 'expense', accountId: 'bank', categoryId: 'bills', amount: 120_000, base: 120_000, date: '2026-12-15', note: 'Seguro Anual', tags: [], created: '2026-11-01T00:00:00Z', repeat: 'yearly', series: 'ser-yr' },
  );
  const out = buildOutlook(s, '2026-11-01', 14);
  assert.equal(out[0].expense, 50_000); // Nov 2, 9, 16, 23, 30 -> 5 Mondays
  assert.equal(out[1].expense, 160_000); // Dec 7,14,21,28 (40k) + yearly (120k)
  assert.equal(out[13].month, '2027-12');
  assert.equal(out[13].expense, 160_000); // Dec 2027: 4 Mondays (6,13,20,27) + yearly
});

test('subscriptionsLikely stays separate from expense and net', () => {
  const s = baseState();
  addPluggyCard(s, 'card-1', [{ id: 'b1', dueDate: '2026-11-10', amountCents: 5_000 }]);
  s.txs.push({
    id: 'fx-1', kind: 'expense', accountId: 'bank', categoryId: 'bills', amount: 10_000, base: 10_000,
    date: '2026-11-05', note: 'Aluguel', tags: [], created: '2026-11-05T00:00:00Z', repeat: 'monthly', series: 'ser-fx',
  });
  for (const [i, cyc] of ['2026-09', '2026-10', '2026-11'].entries()) {
    s.txs.push({
      id: `sub-${i}`, kind: 'expense', accountId: 'card-1', categoryId: 'leisure', amount: 4_500, base: 4_500,
      date: `${cyc}-05`, note: 'STREAM ALFA', tags: [], created: `${cyc}-05T00:00:00Z`,
      pluggy: { apiId: 'api-1', txId: `stx-${i}`, op: 'BUY', billForecastDate: cyc, billCents: 4_500 },
    });
  }
  const out = buildOutlook(s, '2026-11-12', 2);
  assert.equal(out[1].month, '2026-12');
  assert.equal(out[1].subscriptionsLikely, 4_500);
  assert.equal(out[1].expense, 10_000);
  assert.equal(out[1].net, -10_000);
});

test('missing exchange rate marks month incomplete without inventing zero', () => {
  const s = baseState();
  addPluggyCard(s, 'card-usd', [{ id: 'bu', dueDate: '2026-11-10', amountCents: 20_000, currency: 'USD' }], { currency: 'USD' });
  const out = buildOutlook(s, '2026-11-12', 1);
  assert.equal(out[0].complete, false);
  assert.equal(out[0].cardBills, 0);
});

test('division remainder goes to first installment and installmentAmount sets total = value * N', () => {
  const s = baseState();
  const rem = simulatePurchase(s, { amount: 100_000, installments: 3, firstMonth: '2026-12' }, '2026-11-12');
  assert.equal('error' in rem, false);
  if (!('error' in rem)) {
    assert.equal(rem.months[0].installment, 0);
    assert.equal(rem.months[1].installment, 33_334);
    assert.equal(rem.months[2].installment, 33_333);
    assert.equal(rem.months[3].installment, 33_333);
    assert.equal(rem.total, 100_000);
  }
  const byInst = simulatePurchase(s, { installmentAmount: 25_000, installments: 4, firstMonth: '2026-12' }, '2026-11-12');
  assert.equal('error' in byInst, false);
  if (!('error' in byInst)) {
    assert.equal(byInst.total, 100_000);
    assert.equal(byInst.months[1].installment, 25_000);
  }
});

test('simulatePurchase rejects invalid amounts, installments outside 1..120, and out-of-range firstMonth', () => {
  const s = baseState();
  assert.ok('error' in simulatePurchase(s, { amount: 0, installments: 3 }, '2026-11-12'));
  assert.ok('error' in simulatePurchase(s, { amount: -100, installments: 3 }, '2026-11-12'));
  assert.ok('error' in simulatePurchase(s, { amount: 1e300, installments: 2 }, '2026-11-12'));
  assert.ok('error' in simulatePurchase(s, { installmentAmount: 1e300, installments: 2 }, '2026-11-12'));
  assert.ok('error' in simulatePurchase(s, { amount: 10_000, installments: 0 }, '2026-11-12'));
  assert.ok('error' in simulatePurchase(s, { amount: 10_000, installments: 121 }, '2026-11-12'));
  assert.ok('error' in simulatePurchase(s, { amount: 10_000, installments: 3, firstMonth: '2026-10' }, '2026-11-12'));
  assert.ok('error' in simulatePurchase(s, { amount: 10_000, installments: 3, firstMonth: '2030-01' }, '2026-11-12'));
});

test('N4: already saved future recurring occurrence is counted once and never duplicated', () => {
  const s = baseState();
  s.txs.push(
    { id: 'ts1', kind: 'income', accountId: 'bank', categoryId: 'salary', amount: 500_000, base: 500_000, date: '2026-11-05', note: 'Salário', tags: [], created: '2026-11-05T00:00:00Z', repeat: 'monthly', series: 'ser-sal' },
    { id: 'ts2', kind: 'income', accountId: 'bank', categoryId: 'salary', amount: 500_000, base: 500_000, date: '2026-12-05', note: 'Salário', tags: [], created: '2026-11-05T00:00:00Z', repeat: 'monthly', series: 'ser-sal' },
  );
  const out = buildOutlook(s, '2026-11-12', 3);
  assert.equal(out[0].income, 500_000);
  assert.equal(out[1].income, 500_000);
  assert.equal(out[2].income, 500_000);
});

test('N4: recurring series on Pluggy CREDIT card never adds to published bill', () => {
  const s = baseState();
  s.accounts.push({ id: 'mcard', name: 'Cartão Manual', icon: 'cards', color: '#FF5FA2', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 2 });
  addPluggyCard(s, 'pcard', [
    { id: 'b11', dueDate: '2026-11-10', amountCents: 120_000 },
    { id: 'b12', dueDate: '2026-12-10', amountCents: 130_000 },
  ]);
  s.txs.push(
    { id: 'n1', kind: 'income', accountId: 'bank', categoryId: 'salary', amount: 500_000, base: 500_000, date: '2026-11-05', note: 'Salário', tags: [], created: '2026-11-05T00:00:00Z', repeat: 'monthly', series: 's-sal' },
    { id: 'n2', kind: 'expense', accountId: 'bank', categoryId: 'bills', amount: 150_000, base: 150_000, date: '2026-11-10', note: 'Conta Fixa', tags: [], created: '2026-11-10T00:00:00Z', repeat: 'monthly', series: 's-fix' },
    { id: 'n3', kind: 'expense', accountId: 'mcard', categoryId: 'bills', amount: 3_000, base: 3_000, date: '2026-11-10', note: 'Cartão Manual', tags: [], created: '2026-11-10T00:00:00Z', repeat: 'monthly', series: 's-mc' },
    { id: 'n4', kind: 'expense', accountId: 'pcard', categoryId: 'bills', amount: 4_000, base: 4_000, date: '2026-11-10', note: 'Série no Pluggy', tags: [], created: '2026-11-10T00:00:00Z', repeat: 'monthly', series: 's-pc' },
  );
  const out = buildOutlook(s, '2026-11-12', 3);
  const dec = out[1];
  const jan = out[2];
  assert.equal(dec.month, '2026-12');
  assert.equal(dec.income, 500_000);
  assert.equal(dec.expense, 283_000);
  assert.equal(dec.complete, true);
  assert.equal(jan.month, '2027-01');
  assert.equal(jan.basis, 'none');
  assert.equal(jan.complete, false);
});

test('simulatePurchase extends horizon up to 36 and separates turnsNegative vs alreadyNegative', () => {
  const s = baseState();
  s.txs.push(
    { id: 'si', kind: 'income', accountId: 'bank', categoryId: 'salary', amount: 100_000, base: 100_000, date: '2026-11-05', note: 'Renda', tags: [], created: '2026-11-05T00:00:00Z', repeat: 'monthly', series: 's-i' },
    { id: 'se1', kind: 'expense', accountId: 'bank', categoryId: 'bills', amount: 120_000, base: 120_000, date: '2026-12-05', note: 'Gasto pontual', tags: [], created: '2026-11-01T00:00:00Z' },
  );
  const sim = simulatePurchase(s, { amount: 440_000, installments: 40, firstMonth: '2026-12' }, '2026-11-12');
  assert.equal('error' in sim, false);
  if ('error' in sim) return;
  assert.equal(sim.months.length, 36);
  assert.deepEqual(sim.summary.alreadyNegativeMonths, ['2026-12']);
  assert.equal(sim.summary.turnsNegativeMonths.length, 0);

  const flip = simulatePurchase(s, { amount: 1_500_000, installments: 10, firstMonth: '2027-01' }, '2026-11-12');
  assert.equal('error' in flip, false);
  if (!('error' in flip)) {
    assert.equal(flip.summary.turnsNegativeMonths.includes('2027-01'), true);
    assert.equal(flip.summary.turnsNegativeMonths.includes('2026-12'), false);
    assert.equal(flip.summary.worstMonth?.month, '2027-01');
  }
});
