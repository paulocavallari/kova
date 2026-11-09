import { useMemo, useState } from 'react';
import type { Kind } from '../lib/types';
import { useStore } from '../lib/store';
import { useT } from '../i18n';
import { byCategory, filterTx, lastMonths, Period, periodOf, shiftPeriod, sum, today, parseIso, addDays, type Gran } from '../lib/calc';
import { money, monthLabel } from '../lib/format';
import { Bubble, Money, Seg, PeriodNav, Empty } from '../components/ui';
import { Bars, Donut } from '../components/charts';
import { GranPicker, goTx } from './Transactions';
import { Reports } from './Reports';

type Tab = 'reports' | 'overview' | Kind;

export function Charts() {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>('reports');
  return (
    <>
      <div className="topbar"><h1>{t('charts')}</h1></div>
      <Seg<Tab>
        color
        value={tab}
        onChange={setTab}
        options={[
          { v: 'reports', label: t('reports') },
          { v: 'overview', label: t('overview') },
          { v: 'expense', label: t('expenses'), cls: 'expense' },
          { v: 'income', label: t('income'), cls: 'income' },
        ]}
      />
      <div style={{ height: 14 }} />
      {tab === 'reports' ? <Reports /> : tab === 'overview' ? <Overview /> : <KindView kind={tab} key={tab} />}
    </>
  );
}

function Overview() {
  const s = useStore();
  const { t, locale } = useT();
  const [mode, setMode] = useState<'month' | 'year'>('month');
  const [offset, setOffset] = useState(0);
  const [pick, setPick] = useState<number | undefined>(undefined);
  const base = s.settings.baseCurrency;

  const data = useMemo(() => {
    if (mode === 'month') {
      const end = new Date();
      end.setMonth(end.getMonth() - offset * 6);
      const months = lastMonths(6, `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-01`);
      return months.map((m) => {
        const p = periodOf('month', m + '-01');
        const inc = sum(filterTx(s, p, 'income'));
        const exp = sum(filterTx(s, p, 'expense'));
        return { key: m, label: monthLabel(m, locale, 'short', false).replace('.', ''), inc, exp, p };
      });
    }
    const y = new Date().getFullYear() - offset * 5;
    return Array.from({ length: 5 }, (_, i) => String(y - 4 + i)).map((yy) => {
      const p = periodOf('year', `${yy}-01-01`);
      return { key: yy, label: yy, inc: sum(filterTx(s, p, 'income')), exp: sum(filterTx(s, p, 'expense')), p };
    });
  }, [s.txs, mode, offset, locale]);

  const sel = data[pick ?? data.length - 1];
  const net = sel.inc - sel.exp;
  const totals = data.reduce((a, d) => ({ inc: a.inc + d.inc, exp: a.exp + d.exp }), { inc: 0, exp: 0 });
  const fmt = (v: number) => money(v, base, locale, { noCents: true });

  return (
    <>
      <div className="paper">
        <Seg<'month' | 'year'> value={mode} onChange={(m) => { setMode(m); setOffset(0); setPick(undefined); }} options={[{ v: 'month', label: t('byMonth') }, { v: 'year', label: t('byYear') }]} />
        <PeriodNav
          label={`${data[0].label} – ${data[data.length - 1].label}${mode === 'month' ? ' ' + data[data.length - 1].key.slice(0, 4) : ''}`}
          onPrev={() => { setOffset(offset + 1); setPick(undefined); }}
          onNext={() => { setOffset(offset - 1); setPick(undefined); }}
          nextDisabled={offset === 0}
        />
        <Bars
          height={230}
          picked={pick ?? data.length - 1}
          onPick={setPick}
          fmt={fmt}
          groups={data.map((d) => ({
            label: d.label,
            bars: [
              { value: d.inc, color: '#3DD68C' },
              { value: d.exp, color: '#FFB020' },
              { value: Math.max(d.inc - d.exp, 0), color: '#7C5CFF' },
            ],
          }))}
        />
        <div className="legend" style={{ justifyContent: 'center', marginTop: 8 }}>
          <span><i style={{ background: '#3DD68C' }} />{t('income')}</span>
          <span><i style={{ background: '#FFB020' }} />{t('expenses')}</span>
          <span><i style={{ background: '#7C5CFF' }} />{t('profit')}</span>
        </div>
      </div>

      <div className="paper">
        <h3>{mode === 'month' ? monthLabel(sel.key, locale) : sel.key}</h3>
        <div className="stats">
          <div className="st"><span>{t('income')}</span><b className="pos"><Money cents={sel.inc} /></b></div>
          <div className="st"><span>{t('expenses')}</span><b><Money cents={sel.exp} /></b></div>
          <div className="st"><span>{net >= 0 ? t('profit') : t('loss')}</span><b style={{ color: net >= 0 ? 'var(--inc)' : 'var(--exp)' }}><Money cents={net} sign /></b></div>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <span className="small muted grow">{t('savingsRate')}</span>
          <b>{sel.inc ? Math.round((net / sel.inc) * 100) + '%' : '—'}</b>
        </div>
        <div className="bar" style={{ marginTop: 8 }}>
          <i style={{ width: `${sel.inc ? Math.max(0, Math.min(100, (net / sel.inc) * 100)) : 0}%`, background: 'linear-gradient(90deg,#7c5cff,#ff5fa2)' }} />
        </div>
      </div>

      <div className="paper">
        <h3>{t('total')} · {data[0].label} – {data[data.length - 1].label}</h3>
        <div className="stats">
          <div className="st"><span>{t('income')}</span><b className="pos"><Money cents={totals.inc} /></b></div>
          <div className="st"><span>{t('expenses')}</span><b><Money cents={totals.exp} /></b></div>
          <div className="st"><span>{t('net')}</span><b><Money cents={totals.inc - totals.exp} sign /></b></div>
        </div>
      </div>
    </>
  );
}

/** Bars for the trend chart: the selected period and the ones before it, in the same unit. */
function trendPeriods(period: Period, weekStart: 0 | 1): { p: Period; gran: Gran }[] {
  if (period.gran !== 'custom') {
    const n = { day: 7, week: 8, month: 6, year: 5 }[period.gran];
    return Array.from({ length: n }, (_, i) => ({ p: shiftPeriod(period, i - n + 1, weekStart), gran: period.gran }));
  }
  const days = Math.round((parseIso(period.end).getTime() - parseIso(period.start).getTime()) / 864e5) + 1;
  const unit: Gran = days <= 14 ? 'day' : days <= 70 ? 'week' : days <= 1100 ? 'month' : 'year';
  const out: { p: Period; gran: Gran }[] = [];
  let p = periodOf(unit, period.start, weekStart);
  while (p.start <= period.end && out.length < 40) {
    out.push({ p: { gran: unit, start: p.start < period.start ? period.start : p.start, end: p.end > period.end ? period.end : p.end }, gran: unit });
    p = unit === 'day' ? periodOf('day', addDays(p.start, 1)) : shiftPeriod(p, 1, weekStart);
  }
  return out;
}

function KindView({ kind }: { kind: Kind }) {
  const s = useStore();
  const { t, locale } = useT();
  const [period, setPeriod] = useState<Period>(periodOf('month', today(), s.settings.weekStart));
  const [sel, setSel] = useState<string | null>(null);
  const base = s.settings.baseCurrency;

  const { rows, total, prevMap } = useMemo(() => {
    const txs = filterTx(s, period, kind);
    const total = sum(txs);
    const prevP = shiftPeriod(period, -1, s.settings.weekStart);
    const prevMap = new Map(byCategory(filterTx(s, prevP, kind)));
    const rows = byCategory(txs).map(([id, v]) => ({ cat: s.categories.find((c) => c.id === id), id, v }));
    return { rows, total, prevMap };
  }, [s.txs, s.categories, period, kind]);

  const trend = useMemo(() => {
    const top = rows.slice(0, 6).map((r) => r.id);
    return trendPeriods(period, s.settings.weekStart).map(({ p, gran }) => {
      const by = new Map(byCategory(filterTx(s, p, kind)));
      const other = [...by.entries()].filter(([id]) => !top.includes(id)).reduce((a, [, v]) => a + v, 0);
      const d = parseIso(p.start);
      return {
        label: gran === 'month' ? monthLabel(p.start.slice(0, 7), locale, 'short', false).replace('.', '') : gran === 'year' ? p.start.slice(0, 4) : d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }),
        stacked: true,
        bars: [...top.map((id) => ({ value: by.get(id) ?? 0, color: s.categories.find((c) => c.id === id)?.color ?? '#999' })), { value: other, color: '#C9C4DA' }],
      };
    });
  }, [rows, s.txs, period, kind, locale]);

  const selRow = rows.find((r) => r.id === sel);

  return (
    <>
      <div className="paper">
        <GranPicker period={period} setPeriod={(p) => { setPeriod(p); setSel(null); }} />
        {rows.length === 0 ? (
          <Empty title={t('noData')} />
        ) : (
          <div className="donut-wrap">
            <Donut data={rows.map((r) => ({ id: r.id, value: r.v, color: r.cat?.color ?? '#999' }))} selected={sel} onSelect={setSel} />
            <div className="donut-center">
              <div>
                {selRow?.cat && <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}><Bubble icon={selRow.cat.icon} color={selRow.cat.color} size={30} round /></div>}
                <b className="num"><Money cents={selRow ? selRow.v : total} /></b>
                <span>{selRow ? `${selRow.cat?.name} · ${Math.round((selRow.v / total) * 100)}%` : kind === 'expense' ? t('expenses') : t('income')}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <div className="paper flush">
          {rows.map((r) => {
            const pv = prevMap.get(r.id);
            const ch = pv && pv >= 1000 && Math.abs((r.v - pv) / pv) <= 9.99 ? ((r.v - pv) / pv) * 100 : null; // skip meaningless jumps from tiny bases
            const pc = (r.v / (total || 1)) * 100;
            return (
              <button key={r.id} className="item" onClick={() => goTx({ cat: r.id, kind, gran: period.gran, start: period.start, end: period.end })}>
                <Bubble icon={r.cat?.icon ?? 'question'} color={r.cat?.color ?? '#999'} size={44} />
                <div className="grow">
                  <div className="row" style={{ gap: 8 }}>
                    <span className="t grow ellipsis">{r.cat?.name ?? '—'}</span>
                    <span className="small muted" style={{ fontWeight: 600 }}>{Math.round(pc)}%</span>
                    <Money className="amt" cents={r.v} />
                  </div>
                  <div className="row" style={{ gap: 8, marginTop: 6 }}>
                    <div className="bar grow"><i style={{ width: `${Math.max(pc, 2)}%`, background: r.cat?.color }} /></div>
                    {ch !== null && (
                      <span className={'tag ' + ((kind === 'expense' ? ch > 0 : ch < 0) ? 'red' : 'green')}>{ch > 0 ? '+' : ''}{Math.round(ch)}%</span>
                    )}
                  </div>
                  {kind === 'expense' && r.cat?.budget && period.gran === 'month' ? (
                    <div className="s" style={{ marginTop: 4 }}>
                      {r.v <= r.cat.budget ? `${money(r.cat.budget - r.v, base, locale)} ${t('left')}` : `${money(r.v - r.cat.budget, base, locale)} ${t('over')}`}
                    </div>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="paper">
        <h3>{t('trend')}</h3>
        <Bars height={210} groups={trend} fmt={(v) => money(v, base, locale, { noCents: true })} />
      </div>
    </>
  );
}
