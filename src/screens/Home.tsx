import { useEffect, useMemo, useState } from 'react';
import { PiEyeBold, PiEyeSlashBold, PiCaretDownBold, PiCheckBold, PiArrowsClockwiseBold, PiListBulletsBold, PiChartLineUpBold, PiArrowDownLeftBold, PiArrowUpRightBold, PiPiggyBankBold, PiReceiptBold, PiCaretRightBold, PiBellRingingFill } from 'react-icons/pi';
import type { Kind, Tx } from '../lib/types';
import { setState, useBalances, useStore } from '../lib/store';
import { useT } from '../i18n';
import { addDays, byCategory, filterTx, parseIso, Period, periodOf, shiftPeriod, sum, today, toBase, pad } from '../lib/calc';
import { money, shortDate } from '../lib/format';
import { Bubble, Empty, Sheet } from '../components/ui';
import { Donut, PaceChart, CumChart } from '../components/charts';
import { PeriodControl } from '../components/Pickers';
import { navigate, openOverlay, toast, setAddKind, getAddKind } from '../lib/nav';
import { openTxEditor } from '../components/TxEditor';
import { goTx } from './Transactions';
import { upcomingBills } from '../lib/reminders';
import { ShortcutStrip } from '../components/Shortcuts';
import { PendingCard } from '../components/NotifUI';
import { PluggyHomeShortcut } from '../components/PluggyUI';

export function Home() {
  const s = useStore();
  const { t, locale } = useT();
  const { bal, total } = useBalances();
  const base = s.settings.baseCurrency;
  const hide = s.settings.hideBalance;
  const [accId, setAccId] = useState('');
  const [kind, setKind] = useState<Kind>(() => (getAddKind() === 'income' ? 'income' : 'expense'));
  useEffect(() => { setAddKind(kind); }, [kind]);
  const [period, setPeriod] = useState<Period>(() => periodOf('month', today(), s.settings.weekStart));
  const [sel, setSel] = useState<string | null>(null);
  const [paceView, setPaceView] = useState<'cum' | 'daily'>('cum');
  const acc = s.accounts.find((a) => a.id === accId);
  const accOpt = accId || undefined;

  const { rows, totalV } = useMemo(() => {
    const txs = filterTx(s, period, kind, accOpt);
    const rows = byCategory(txs).map(([id, v]) => ({ id, v, cat: s.categories.find((c) => c.id === id) }));
    return { rows, totalV: sum(txs) };
  }, [s.txs, s.categories, period, kind, accId]);

  const month = useMemo(() => {
    const m = periodOf('month', today());
    const i = sum(filterTx(s, m, 'income', accOpt));
    const e = sum(filterTx(s, m, 'expense', accOpt));
    return { m, i, e, rate: i ? Math.round(((i - e) / i) * 100) : null };
  }, [s.txs, accId]);

  const pace = useMemo(() => {
    if (period.gran === 'day') return null;
    const txs = filterTx(s, period, kind, accOpt);
    const now = today();
    const days = Math.round((parseIso(period.end).getTime() - parseIso(period.start).getTime()) / 864e5) + 1;
    const byMonth = period.gran === 'year' || days > 62;
    const buckets: { key: string; label: string; value: number; today?: boolean; full?: string }[] = [];
    if (byMonth) {
      const d0 = parseIso(period.start);
      for (let m = new Date(d0.getFullYear(), d0.getMonth(), 1); m <= parseIso(period.end); m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
        const key = `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
        buckets.push({ key, label: m.toLocaleDateString(locale, { month: 'narrow' }), full: m.toLocaleDateString(locale, { month: 'short' }).replace('.', ''), value: 0, today: now.startsWith(key) });
      }
      for (const x of txs) { const b = buckets.find((k) => k.key === x.date.slice(0, 7)); if (b) b.value += x.base; }
    } else {
      for (let d = period.start; d <= period.end; d = addDays(d, 1)) {
        const dt = parseIso(d);
        buckets.push({ key: d, label: period.gran === 'week' ? dt.toLocaleDateString(locale, { weekday: 'short' }).replace('.', '') : String(dt.getDate()), full: shortDate(d, locale), value: 0, today: d === now });
      }
      const idx = new Map(buckets.map((b, i) => [b.key, i]));
      for (const x of txs) { const i = idx.get(x.date); if (i !== undefined) buckets[i].value += x.base; }
    }
    const totalP = sum(txs);
    const elapsed = buckets.filter((b) => b.key <= now.slice(0, b.key.length)).length || buckets.length;
    const avg = totalP / Math.max(1, elapsed);
    const isCurrent = period.start <= now && now <= period.end;
    const prevP = shiftPeriod(period, -1, s.settings.weekStart);
    // current period: compare up to the same point (day 1–24 vs day 1–24), not against the whole previous period
    let cmpNow = totalP, prevTotal = 0, sameLabel: string | null = null;
    if (isCurrent) {
      const offset = Math.round((parseIso(now).getTime() - parseIso(period.start).getTime()) / 864e5);
      const prevEnd = addDays(prevP.start, offset) < prevP.end ? addDays(prevP.start, offset) : prevP.end;
      cmpNow = sum(txs.filter((x) => x.date <= now));
      prevTotal = sum(filterTx(s, { start: prevP.start, end: prevEnd }, kind, accOpt));
      if (period.gran === 'month') sameLabel = t('vsSameDay', { d: String(parseIso(prevEnd).getDate()), m: parseIso(prevP.start).toLocaleDateString(locale, { month: 'short' }).replace('.', '') });
    } else prevTotal = sum(filterTx(s, prevP, kind, accOpt));
    // running totals: this period (up to today) and the previous one, bucket by bucket
    const prevTxs = filterTx(s, prevP, kind, accOpt);
    const prevVals: number[] = [];
    if (byMonth) {
      const d0 = parseIso(prevP.start);
      for (let m = new Date(d0.getFullYear(), d0.getMonth(), 1); m <= parseIso(prevP.end); m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
        const key = `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
        prevVals.push(sum(prevTxs.filter((x) => x.date.startsWith(key))));
      }
    } else {
      for (let d = prevP.start; d <= prevP.end; d = addDays(d, 1)) prevVals.push(sum(prevTxs.filter((x) => x.date === d)));
    }
    let acc0 = 0;
    const prevCum = prevVals.map((v) => (acc0 += v));
    acc0 = 0;
    const curCum = buckets.filter((b) => !isCurrent || b.key <= now.slice(0, b.key.length)).map((b) => (acc0 += b.value));
    const prevName = byMonth ? String(parseIso(prevP.start).getFullYear()) : period.gran === 'month' ? parseIso(prevP.start).toLocaleDateString(locale, { month: 'short' }).replace('.', '') : t('previousPeriod');
    const curName = byMonth ? String(parseIso(period.start).getFullYear()) : period.gran === 'month' ? parseIso(period.start).toLocaleDateString(locale, { month: 'short' }).replace('.', '') : t('thisPeriod');
    return { buckets, avg, total: totalP, byMonth, projection: isCurrent ? Math.round(avg * buckets.length) : null, change: prevTotal ? ((cmpNow - prevTotal) / prevTotal) * 100 : null, sameLabel, curCum, prevCum, curName, prevName };
  }, [s.txs, period, kind, accId, locale]);

  const bills = useMemo(() => upcomingBills(s).filter((x) => !accId || x.accountId === accId).slice(0, 4), [s.txs, accId]);
  const planned = useMemo(() => {
    const now = today();
    return s.txs.filter((x) => x.date > now && !x.done && !x.series && (!accId || x.accountId === accId)).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 4);
  }, [s.txs, accId]);

  const balanceV = acc ? bal.get(acc.id) ?? 0 : total;
  const balanceCur = acc ? acc.currency : base;
  const selRow = rows.find((r) => r.id === sel);
  const monthQ = { gran: 'month', start: month.m.start, end: month.m.end, ...(accId ? { acc: accId } : {}) };

  const pickAccount = () =>
    openOverlay((close) => (
      <Sheet title={t('selectAccount')}>
        <div className="sheet-b">
          <div className="paper flush">
            {[{ id: '', name: t('total'), icon: 'wallet', color: '#5B3DF5', currency: base }, ...s.accounts.filter((a) => !a.archived).sort((a, b) => a.order - b.order)].map((a) => {
              const v = a.id ? bal.get(a.id) ?? 0 : total;
              return (
                <button key={a.id || 'total'} className="item" onClick={() => { setAccId(a.id); setSel(null); close(); }}>
                  <Bubble icon={a.icon} color={a.color} size={40} />
                  <div className="grow">
                    <div className="t">{a.name}</div>
                    <div className="s">{hide ? '••••••' : money(v, a.currency, locale)}</div>
                  </div>
                  {accId === a.id && <PiCheckBold size={20} />}
                </button>
              );
            })}
          </div>
        </div>
      </Sheet>
    ));

  return (
    <>
      <div className="hero">
        <div className="bar-top">
          <button className="acct glass" onClick={pickAccount}>
            <Bubble icon={acc?.icon ?? 'wallet'} color={acc?.color ?? '#FFFFFF'} size={28} solid={!!acc} />
            {acc?.name ?? t('total')}
            <PiCaretDownBold className="caret" />
          </button>
          <div className="grow" />
          <button className="eye glass" onClick={() => setState((st) => ({ ...st, settings: { ...st.settings, hideBalance: !st.settings.hideBalance } }))} aria-label="hide balance">
            {hide ? <PiEyeSlashBold /> : <PiEyeBold />}
          </button>
        </div>
        <div className="lbl">{acc ? t('balance') : t('totalBalance')}</div>
        <div className={'big' + (hide ? ' hidden' : '')}>{hide ? '••••••' : money(balanceV, balanceCur, locale)}</div>
        {acc && acc.currency !== base && !hide && <div className="sub">≈ {money(toBase(s, balanceV, acc.currency), base, locale)}</div>}
        <div className="tiles">
          <button className="glass" onClick={() => goTx({ kind: 'income', ...monthQ })}>
            <span><i><PiArrowDownLeftBold /></i>{t('income')}</span>
            <b>{money(month.i, base, locale)}</b>
          </button>
          <button className="glass" onClick={() => goTx({ kind: 'expense', ...monthQ })}>
            <span><i><PiArrowUpRightBold /></i>{t('expenses')}</span>
            <b>{money(month.e, base, locale)}</b>
          </button>
          <button className="glass" onClick={() => navigate('/charts')}>
            <span><i><PiPiggyBankBold /></i>{t('savedShort')}</span>
            <b>{month.rate === null ? '—' : `${month.rate}%`}</b>
          </button>
        </div>
        {s.settings.shortcutsOn !== false && (s.shortcuts?.length ?? 0) > 0 && <ShortcutStrip />}
      </div>

      <div className="paper lift">
        <div className="tabs-center">
          <div className="track">
            <span className="thumb" style={{ width: 'calc(50% - 4px)', transform: `translateX(${kind === 'expense' ? 0 : 100}%)` }} />
            <button className={kind === 'expense' ? 'on' : ''} onClick={() => { setKind('expense'); setSel(null); }}><span className="dot" style={{ background: 'var(--exp)' }} />{t('expenses')}</button>
            <button className={kind === 'income' ? 'on' : ''} onClick={() => { setKind('income'); setSel(null); }}><span className="dot" style={{ background: 'var(--inc)' }} />{t('income')}</button>
          </div>
        </div>
        <PeriodControl period={period} setPeriod={(p) => { setPeriod(p); setSel(null); }} />

        {rows.length === 0 ? (
          <Empty icon="sparkle" title={t('noData')} hint={t('noDataHint')} />
        ) : (
          <div className="donut-wrap">
            <Donut data={rows.map((r) => ({ id: r.id, value: r.v, color: r.cat?.color ?? '#999' }))} selected={sel} onSelect={setSel} />
            <div className="donut-center">
              <div>
                <b className="num">{money(selRow ? selRow.v : totalV, base, locale)}</b>
                <span>{selRow ? `${selRow.cat?.name} · ${Math.round((selRow.v / (totalV || 1)) * 100)}%` : kind === 'expense' ? t('expenses') : t('income')}</span>
              </div>
            </div>
          </div>
        )}

        {rows.map((r) => {
          const pc = (r.v / (totalV || 1)) * 100;
          return (
            <button key={r.id} className="cat-row" onClick={() => goTx({ cat: r.id, kind, gran: period.gran, start: period.start, end: period.end, ...(accId ? { acc: accId } : {}) })}>
              <Bubble icon={r.cat?.icon ?? 'question'} color={r.cat?.color ?? '#999'} size={44} />
              <span className="nm">{r.cat?.name ?? '—'}</span>
              <span className="v">{money(r.v, base, locale)}</span>
              <div className="meta">
                <div className="bar grow"><i style={{ width: `${Math.max(pc, 1.5)}%`, background: r.cat?.color }} /></div>
                <span className="pc">{pc < 1 ? '<1' : Math.round(pc)}%</span>
              </div>
            </button>
          );
        })}
      </div>

      {pace && pace.total > 0 && (
        <div className="paper">
          <h3>
            {kind === 'expense' ? t('spendingPace') : t('incomePace')}
            {pace.change !== null && Math.abs(pace.change) >= 1 && (
              <span className={'tag ' + ((kind === 'expense' ? pace.change > 0 : pace.change < 0) ? 'red' : 'green')} style={{ marginLeft: 'auto' }}>
                {pace.change > 300 ? '>300' : `${pace.change > 0 ? '+' : ''}${Math.round(pace.change)}`}% {pace.sameLabel ?? t('vsPrevPeriod')}
              </span>
            )}
          </h3>
          <div className="seg-mini">
            <button className={paceView === 'cum' ? 'on' : ''} onClick={() => setPaceView('cum')}>{t('cumulative')}</button>
            <button className={paceView === 'daily' ? 'on' : ''} onClick={() => setPaceView('daily')}>{pace.byMonth ? t('monthlyBars') : t('daily')}</button>
          </div>
          {paceView === 'cum' ? (
            <CumChart key={period.gran + period.start + kind} cur={pace.curCum} prev={pace.prevCum} labels={pace.buckets.map((b) => b.label)} fulls={pace.buckets.map((b) => b.full ?? b.label)} curName={pace.curName} prevName={pace.prevName}
              color={kind === 'expense' ? '#EF4444' : '#10A36A'} fmt={(v) => money(v, base, locale)} />
          ) : (
            <PaceChart data={pace.buckets} avg={pace.avg} color={kind === 'expense' ? '#EF4444' : '#10A36A'} fmt={(v) => money(v, base, locale)} />
          )}
          <div className="small muted" style={{ margin: '4px 6px 0' }}>{paceView === 'cum' ? t('tapLine') : t('tapBar')}</div>
          <div className="stats" style={{ marginTop: 6 }}>
            <div className="st"><span>{pace.byMonth ? t('monthlyAvg') : t('dailyAvg')}</span><b>{money(Math.round(pace.avg), base, locale)}</b></div>
            {pace.projection !== null && <div className="st"><span>{t('projected')}</span><b style={{ color: 'var(--brand)' }}>{money(pace.projection, base, locale)}</b></div>}
          </div>
        </div>
      )}

      <PendingCard />
      <PluggyHomeShortcut />

      {(bills.length > 0 || planned.length > 0) && (
        <>
          <button className="section-title" style={{ width: 'calc(100% - 16px)' }} onClick={() => navigate('/bills')}>
            {t('upcoming')} <span className="link">{t('seeAll')} <PiCaretRightBold /></span>
          </button>
          <div className="paper flush">
            {[...bills, ...planned].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 5).map((x) => <PlannedRow key={x.id} tx={x} />)}
          </div>
        </>
      )}

      <div className="qa">
        <button onClick={() => goTx(accId ? { acc: accId } : {})}>
          <span className="set-ico"><PiListBulletsBold /></span>{t('transactions')}
        </button>
        <button onClick={() => navigate('/bills')}>
          <span className="set-ico" style={{ background: 'var(--plan-soft)', color: 'var(--plan)' }}><PiReceiptBold /></span>{t('fixedBills')}
        </button>
        <button onClick={() => navigate('/charts')}>
          <span className="set-ico" style={{ background: 'var(--brand-soft)', color: 'var(--brand)' }}><PiChartLineUpBold /></span>{t('reports')}
        </button>
      </div>
    </>
  );
}

export function PlannedRow({ tx }: { tx: Tx }) {
  const s = useStore();
  const { t, locale } = useT();
  const cat = s.categories.find((c) => c.id === tx.categoryId);
  const acc = s.accounts.find((a) => a.id === tx.accountId);
  const days = Math.round((parseIso(tx.date).getTime() - parseIso(today()).getTime()) / 864e5);
  const confirm = () => {
    setState((st) => ({ ...st, txs: st.txs.map((x) => (x.id === tx.id ? { ...x, done: true } : x)) }));
    toast(t('confirmed'));
  };
  return (
    <div className="item" style={{ cursor: 'pointer' }} onClick={() => openTxEditor({ tx })}>
      <Bubble icon={cat?.icon ?? 'question'} color={cat?.color ?? '#999'} size={42} />
      <div className="grow">
        <div className="t">{tx.note || cat?.name}</div>
        <div className="s" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span className={'tag ' + (days <= 3 ? 'red' : 'plan')}>{days === 1 ? t('tomorrow') : `${shortDate(tx.date, locale)} · ${t('inDays', { n: String(days) })}`}</span>
          {acc?.name}
          {tx.repeat && <><PiArrowsClockwiseBold size={11} /> {t(tx.repeat)}</>}
          {tx.remind !== undefined && tx.remind >= 0 && <PiBellRingingFill size={12} style={{ color: 'var(--brand)' }} />}
        </div>
      </div>
      <div className="right">
        <div className={'amt ' + (tx.kind === 'income' ? 'pos' : 'neg')}>{tx.kind === 'income' ? '+' : '−'}{money(tx.amount, acc?.currency ?? s.settings.baseCurrency, locale)}</div>
        <button className="mini-btn" style={{ marginTop: 6 }} onClick={(e) => { e.stopPropagation(); confirm(); }}>{tx.kind === 'income' ? t('markReceived') : t('markPaid')}</button>
      </div>
    </div>
  );
}
