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
const { OverlayHost } = await import('../src/components/ui');
const { initialState } = await import('../src/lib/defaults');
const { setDaySourceForTest } = await import('../src/lib/useToday');

test('open estimates show per-item origin, unknown origin and failed sync', async () => {
  setDaySourceForTest(() => '2026-11-11');
  const s = initialState('pt');
  const ids = ['old', 'new', 'legacy'];
  store.replaceState({ ...s, settings: { ...s.settings, lang: 'pt' }, accounts: ids.map((id, order) => ({ id, name: id, icon: 'cards', color: '', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order, pluggy: { apiId: 'a', accountId: id, type: 'CREDIT', itemId: id === 'legacy' ? undefined : id } })), txs: ids.map((id) => ({ id, kind: 'expense', accountId: id, categoryId: '', amount: 100, base: 100, date: '2026-11-01', note: '', tags: [], created: '', pluggy: { apiId: 'a', txId: id, op: '', billForecastDate: '2026-12', billCents: 100 } })), pluggy: [{ id: 'a', name: 'a', clientId: '', clientSecret: '', baseUrl: '', itemIds: [], enabled: true, auto: true, lastStatus: 'error', lastSyncAt: '2026-11-11T12:00:00Z', itemUpdatedAt: { old: '2026-11-01T12:00:00Z', new: '2026-11-11T12:00:00Z' } }] });
  const box = document.createElement('div'); document.body.appendChild(box);
  const root = createRoot(box);
  await React.act(async () => root.render(React.createElement(Accounts)));
  const rows = [...box.querySelectorAll('.row')].map((row) => row.textContent ?? '');
  assert.match(rows.find((r) => r.includes('old'))!, /Fatura aberta \(estimativa\).*dez\..*dados de 01\/11\/2026.*sincronização falhou/);
  assert.match(rows.find((r) => r.includes('new'))!, /dados de 11\/11\/2026/);
  assert.match(rows.find((r) => r.includes('legacy'))!, /coletado .*origem desconhecida/);
  assert.doesNotMatch(rows.find((r) => r.includes('legacy'))!, /dados de/);
  await React.act(async () => { store.replaceState({ ...store.getState(), settings: { ...store.getState().settings, monthlyCardView: false } }); });
  assert.doesNotMatch(box.textContent ?? '', /Fatura aberta/);
  await React.act(async () => { store.replaceState({ ...store.getState(), settings: { ...store.getState().settings, monthlyCardView: true }, txs: store.getState().txs.map((tx) => ({ ...tx, kind: 'income' })) }); });
  assert.doesNotMatch(box.textContent ?? '', /Fatura aberta/);
  await React.act(async () => root.unmount()); box.remove();
  setDaySourceForTest();
});

test('open estimate coexists with unavailable or published monthly bill without changing its amount', async () => {
  setDaySourceForTest(() => '2026-11-11');
  const s = initialState('pt');
  const card = { id: 'card', name: 'Cartão teste', icon: 'cards', color: '', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 0, pluggy: { apiId: 'a', accountId: 'card', type: 'CREDIT', itemId: 'item' } };
  const purchase = { id: 'buy', kind: 'expense' as const, accountId: 'card', categoryId: '', amount: 12345, base: 12345, date: '2026-11-01', note: '', tags: [], created: '', pluggy: { apiId: 'a', txId: 'buy', op: '', billForecastDate: '2026-12', billCents: 12345 } };
  const base = { ...s, settings: { ...s.settings, lang: 'pt' }, accounts: [card], txs: [purchase] };
  store.replaceState(base);
  const box = document.createElement('div');
  document.body.appendChild(box);
  const root = createRoot(box);
  try {
    await React.act(async () => root.render(React.createElement(Accounts)));
    assert.match(box.textContent ?? '', /Fatura indisponível/);
    assert.match(box.textContent ?? '', /123,45.*Fatura aberta \(estimativa\).*dez\..*origem desconhecida/);
    const withBill = { ...card, pluggy: { ...card.pluggy, bills: { status: 'fresh' as const, fetchedAt: '2026-11-09T12:00:00Z', items: [{ id: 'bill', dueDate: '2026-11-10', amountCents: 30000, currency: 'BRL' }] } } };
    await React.act(async () => { store.replaceState({ ...base, accounts: [withBill], txs: [] }); });
    const primaryBefore = box.querySelector('.row .amt')?.textContent;
    assert.match(primaryBefore ?? '', /300,00/);
    await React.act(async () => { store.replaceState({ ...base, accounts: [withBill] }); });
    assert.equal(box.querySelector('.row .amt')?.textContent, primaryBefore);
    assert.match(box.textContent ?? '', /Fatura que vence neste mês/);
    assert.match(box.textContent ?? '', /123,45.*Fatura aberta \(estimativa\)/);
  } finally {
    await React.act(async () => root.unmount());
    box.remove();
    setDaySourceForTest();
  }
});

test('next bills button lists every open cycle of a card with two or more', async () => {
  setDaySourceForTest(() => '2026-11-11');
  const s = initialState('pt');
  const card = { id: 'card', name: 'Cartão teste', icon: 'cards', color: '', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 0, pluggy: { apiId: 'a', accountId: 'card', type: 'CREDIT', itemId: 'item' } };
  const tx = (id: string, cycle: string, cents: number) => ({ id, kind: 'expense' as const, accountId: 'card', categoryId: '', amount: cents, base: cents, date: '2026-11-01', note: '', tags: [], created: '', pluggy: { apiId: 'a', txId: id, op: '', billForecastDate: cycle, billCents: cents } });
  store.replaceState({ ...s, settings: { ...s.settings, lang: 'pt', monthlyCardView: true }, accounts: [card], txs: [tx('d', '2026-12', 10000), tx('j', '2027-01', 20000), tx('f', '2027-02', 30000)] });
  const box = document.createElement('div');
  document.body.appendChild(box);
  const root = createRoot(box);
  try {
    await React.act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(Accounts), React.createElement(OverlayHost))));
    const button = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Próximas faturas');
    assert.ok(button, 'botão Próximas faturas ausente');
    await React.act(async () => button!.click());
    const sheet = document.querySelector('.sheet')?.textContent ?? '';
    assert.match(sheet, /dez\..*100,00.*\(1 item\)|dez\..*100,00/);
    assert.match(sheet, /jan\..*200,00/);
    assert.match(sheet, /fev\..*300,00/);
    assert.match(sheet, /estimativa/);
  } finally {
    await React.act(async () => root.unmount());
    box.remove();
    setDaySourceForTest();
  }
});

test('next bills button is hidden when monthly view is off or the card has one cycle', async () => {
  setDaySourceForTest(() => '2026-11-11');
  const s = initialState('pt');
  const card = { id: 'card', name: 'Cartão teste', icon: 'cards', color: '', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 0, pluggy: { apiId: 'a', accountId: 'card', type: 'CREDIT', itemId: 'item' } };
  const tx = (id: string, cycle: string) => ({ id, kind: 'expense' as const, accountId: 'card', categoryId: '', amount: 100, base: 100, date: '2026-11-01', note: '', tags: [], created: '', pluggy: { apiId: 'a', txId: id, op: '', billForecastDate: cycle, billCents: 100 } });
  const box = document.createElement('div');
  document.body.appendChild(box);
  const root = createRoot(box);
  const has = () => [...box.querySelectorAll('button')].some((b) => b.textContent === 'Próximas faturas');
  try {
    store.replaceState({ ...s, settings: { ...s.settings, lang: 'pt', monthlyCardView: false }, accounts: [card], txs: [tx('d', '2026-12'), tx('j', '2027-01')] });
    await React.act(async () => root.render(React.createElement(Accounts)));
    assert.equal(has(), false);
    store.replaceState({ ...s, settings: { ...s.settings, lang: 'pt', monthlyCardView: true }, accounts: [card], txs: [tx('d', '2026-12')] });
    await React.act(async () => root.render(React.createElement(Accounts)));
    assert.equal(has(), false);
  } finally {
    await React.act(async () => root.unmount());
    box.remove();
    setDaySourceForTest();
  }
});

test('next bills sheet shows remaining installments apart from the published amount', async () => {
  setDaySourceForTest(() => '2026-11-11');
  const s = initialState('pt');
  const card = { id: 'card', name: 'Cartão teste', icon: 'cards', color: '', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 0, pluggy: { apiId: 'a', accountId: 'card', type: 'CREDIT', itemId: 'item', bills: { status: 'fresh' as const, fetchedAt: '2026-11-09T12:00:00Z', items: [{ id: 'bill-old', dueDate: '2026-11-10', amountCents: 30000, currency: 'BRL' }] } } };
  const cycleTx = (id: string, cycle: string, cents: number) => ({ id, kind: 'expense' as const, accountId: 'card', categoryId: '', amount: cents, base: cents, date: '2026-11-01', note: id, tags: [], created: '', pluggy: { apiId: 'a', txId: id, op: '', billForecastDate: cycle, billCents: cents } });
  const plan = (n: number) => ({ ...cycleTx(`p${n}`, '', 15304), pluggy: { apiId: 'a', txId: `p${n}`, op: '', billId: 'bill-old', billCents: 15304, installmentNumber: n, totalInstallments: 21, purchaseDate: '2026-03-05' } });
  store.replaceState({ ...s, settings: { ...s.settings, lang: 'pt', monthlyCardView: true }, accounts: [card], txs: [cycleTx('d', '2026-12', 10000), cycleTx('j', '2027-01', 20000), plan(18), plan(19)] });
  const box = document.createElement('div');
  document.body.appendChild(box);
  const root = createRoot(box);
  try {
    await React.act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(Accounts), React.createElement(OverlayHost))));
    const button = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Próximas faturas');
    assert.ok(button, 'botão Próximas faturas ausente');
    await React.act(async () => button!.click());
    const sheet = [...document.querySelectorAll('.sheet')].pop()?.textContent ?? '';
    assert.match(sheet, /Parcelas restantes: R\$\s153,04 \(1\)/);
    assert.match(sheet, /dez\..*100,00/);
  } finally {
    await React.act(async () => root.unmount());
    box.remove();
    setDaySourceForTest();
  }
});

test('next bills sheet has no installments line when no installment is pending', async () => {
  setDaySourceForTest(() => '2026-11-11');
  const s = initialState('pt');
  const card = { id: 'card', name: 'Cartão teste', icon: 'cards', color: '', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 0, pluggy: { apiId: 'a', accountId: 'card', type: 'CREDIT', itemId: 'item' } };
  const cycleTx = (id: string, cycle: string, cents: number) => ({ id, kind: 'expense' as const, accountId: 'card', categoryId: '', amount: cents, base: cents, date: '2026-11-01', note: id, tags: [], created: '', pluggy: { apiId: 'a', txId: id, op: '', billForecastDate: cycle, billCents: cents } });
  store.replaceState({ ...s, settings: { ...s.settings, lang: 'pt', monthlyCardView: true }, accounts: [card], txs: [cycleTx('d', '2026-12', 10000), cycleTx('j', '2027-01', 20000)] });
  const box = document.createElement('div');
  document.body.appendChild(box);
  const root = createRoot(box);
  try {
    await React.act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(Accounts), React.createElement(OverlayHost))));
    const button = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Próximas faturas');
    await React.act(async () => button!.click());
    const sheet = [...document.querySelectorAll('.sheet')].pop()?.textContent ?? '';
    assert.match(sheet, /dez\./);
    assert.doesNotMatch(sheet, /Parcelas restantes/);
  } finally {
    await React.act(async () => root.unmount());
    box.remove();
    setDaySourceForTest();
  }
});

test('monthly view off shows neither the next bills button nor installments', async () => {
  setDaySourceForTest(() => '2026-11-11');
  const s = initialState('pt');
  const card = { id: 'card', name: 'Cartão teste', icon: 'cards', color: '', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 0, pluggy: { apiId: 'a', accountId: 'card', type: 'CREDIT', itemId: 'item', bills: { status: 'fresh' as const, fetchedAt: '2026-11-09T12:00:00Z', items: [{ id: 'bill-old', dueDate: '2026-11-10', amountCents: 30000, currency: 'BRL' }] } } };
  const cycleTx = (id: string, cycle: string, cents: number) => ({ id, kind: 'expense' as const, accountId: 'card', categoryId: '', amount: cents, base: cents, date: '2026-11-01', note: id, tags: [], created: '', pluggy: { apiId: 'a', txId: id, op: '', billForecastDate: cycle, billCents: cents } });
  const plan = (n: number) => ({ ...cycleTx(`p${n}`, '', 15304), pluggy: { apiId: 'a', txId: `p${n}`, op: '', billId: 'bill-old', billCents: 15304, installmentNumber: n, totalInstallments: 21, purchaseDate: '2026-03-05' } });
  store.replaceState({ ...s, settings: { ...s.settings, lang: 'pt', monthlyCardView: false }, accounts: [card], txs: [cycleTx('d', '2026-12', 10000), cycleTx('j', '2027-01', 20000), plan(18), plan(19)] });
  const box = document.createElement('div');
  document.body.appendChild(box);
  const root = createRoot(box);
  try {
    await React.act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(Accounts), React.createElement(OverlayHost))));
    assert.equal([...box.querySelectorAll('button')].some((b) => b.textContent === 'Próximas faturas'), false);
    const accountRows = [...box.querySelectorAll('.row')].map((r) => r.textContent ?? '').join(' ');
    assert.match(accountRows, /Cartão teste/);
    assert.doesNotMatch(accountRows, /Parcelas restantes/);
  } finally {
    await React.act(async () => root.unmount());
    box.remove();
    setDaySourceForTest();
  }
});

test('next bills sheet shows likely subscriptions on their own line', async () => {
  setDaySourceForTest(() => '2026-11-11');
  const s = initialState('pt');
  const card = { id: 'card', name: 'Cartão teste', icon: 'cards', color: '', currency: 'BRL', initial: 0, includeInTotal: true, archived: false, order: 0, pluggy: { apiId: 'a', accountId: 'card', type: 'CREDIT', itemId: 'item', bills: { status: 'fresh' as const, fetchedAt: '2026-10-09T12:00:00Z', items: [{ id: 'bill-old', dueDate: '2026-10-10', amountCents: 30000, currency: 'BRL' }] } } };
  const cycleTx = (id: string, cycle: string, cents: number, bill?: string) => ({ id, kind: 'expense' as const, accountId: 'card', categoryId: '', amount: cents, base: cents, date: '2026-11-01', note: 'NETFLIX', tags: [], created: '', pluggy: { apiId: 'a', txId: id, op: 'PAGAMENTO', billId: bill, billForecastDate: cycle, billCents: cents } });
  store.replaceState({ ...s, settings: { ...s.settings, lang: 'pt', monthlyCardView: true }, accounts: [card], txs: [cycleTx('s1', '2026-08', 5590, 'b8'), cycleTx('s2', '2026-09', 5590, 'b9'), cycleTx('s3', '2026-10', 5590, 'b10'), cycleTx('d', '2026-12', 10000), cycleTx('j', '2027-01', 20000)] });
  const box = document.createElement('div');
  document.body.appendChild(box);
  const root = createRoot(box);
  try {
    await React.act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(Accounts), React.createElement(OverlayHost))));
    const button = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Próximas faturas');
    assert.ok(button, 'botão Próximas faturas ausente');
    await React.act(async () => button!.click());
    const sheet = [...document.querySelectorAll('.sheet')].pop()?.textContent ?? '';
    assert.match(sheet, /Assinaturas prováveis \(estimativa\): R\$\s55,90 \(1\)/);
  } finally {
    await React.act(async () => root.unmount());
    box.remove();
    setDaySourceForTest();
  }
});
