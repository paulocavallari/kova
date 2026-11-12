import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const g = globalThis as any;
for (const key of ['window', 'document', 'location', 'history', 'localStorage', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent']) g[key] = (dom.window as any)[key];
g.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const store = await import('../src/lib/store');
const { Accounts } = await import('../src/screens/Accounts');
const { initialState } = await import('../src/lib/defaults');
const { setDaySourceForTest } = await import('../src/lib/useToday');
const { openBills } = await import('../src/lib/open-bill');

async function exercise(kind: 'expense' | 'income', cents: number | undefined, check: (box: HTMLElement) => void) {
  setDaySourceForTest(() => '2026-11-11');
  const s = initialState('pt');
  const acc = { id: 'card', name: 'Mercado Pago', icon: 'cards', color: '', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 0, pluggy: { apiId: 'a', accountId: 'card', type: 'CREDIT', itemId: 'item', forecastGap: true, bills: { status: 'fresh' as const, fetchedAt: '2026-11-11T12:00:00Z', items: [{ id: 'bill', dueDate: '2026-11-10', amountCents: 656989, currency: 'BRL' }] } } };
  const state = { ...s, settings: { ...s.settings, lang: 'pt' as const }, accounts: [acc], txs: [{ id: 'buy', kind, accountId: 'card', categoryId: '', amount: 100, base: 100, date: '2026-11-01', note: '', tags: [], created: '', pluggy: { apiId: 'a', txId: 'buy', op: '', billForecastDate: '2026-12', billCents: cents } }] };
  store.replaceState(state);
  const box = document.createElement('div'); document.body.appendChild(box);
  const root = createRoot(box);
  try {
    await React.act(async () => root.render(React.createElement(Accounts)));
    check(box);
  } finally {
    await React.act(async () => root.unmount()); box.remove(); setDaySourceForTest();
  }
  return openBills(state, 'card', '2026-11-11')[0];
}
test('partial estimate shows full amount and coverage notice', async () => {
  const row = await exercise('expense', 573058, (box) => {
    assert.match(box.textContent ?? '', /5\.730,58/);
    assert.match(box.textContent ?? '', /cobertura incompleta/);
  });
  assert.equal(row.status, 'partial');
});
test('monthly amount and label are separate elements', async () => {
  await exercise('expense', 100, (box) => {
    const amount = [...box.querySelectorAll('.amt')].find((el) => el.textContent?.includes('6.569,89'));
    const label = [...box.querySelectorAll('.meta')].find((el) => el.textContent?.includes('Fatura que vence'));
    assert.ok(amount); assert.ok(label); assert.notEqual(amount, label);
  });
});
test('estimate amount and metadata are separate elements', async () => {
  await exercise('expense', 573058, (box) => {
    const amount = [...box.querySelectorAll('.amt2:not(.meta)')].find((el) => el.textContent?.includes('5.730,58'));
    const label = [...box.querySelectorAll('.amt2.meta')].find((el) => el.textContent?.includes('Fatura aberta'));
    assert.ok(amount); assert.ok(label); assert.notEqual(amount, label);
  });
});
test('negative with gap and invalid billCents hide estimate', async () => {
  const negative = await exercise('income', 100, (box) => assert.doesNotMatch(box.textContent ?? '', /Fatura aberta/));
  assert.equal(negative.status, 'negative');
  const invalid = await exercise('expense', undefined, (box) => assert.doesNotMatch(box.textContent ?? '', /Fatura aberta/));
  assert.equal(invalid.status, 'error');
});
