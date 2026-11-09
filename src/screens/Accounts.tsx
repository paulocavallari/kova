import { useMemo, useState } from 'react';
import { PiPlusBold, PiClockCounterClockwiseBold, PiArrowsLeftRightBold, PiCaretDownBold, PiCaretUpBold, PiCheckBold, PiArrowsDownUpBold, PiDotsSixVerticalBold, PiHandGrabbingBold } from 'react-icons/pi';
import { setState, useBalances, useStore } from '../lib/store';
import { useT } from '../i18n';
import { accountsSorted, toBase } from '../lib/calc';
import { monthlyProjection } from '../lib/monthly';
import { MonthlyToggle } from '../components/MonthlyToggle';
import { useToday } from '../lib/useToday';
import { money } from '../lib/format';
import { Bubble } from '../components/ui';
import { openAccountEditor } from '../components/Editors';
import { openTxEditor } from '../components/TxEditor';
import { navigate } from '../lib/nav';
import { Sortable } from '../components/Sortable';

export function Accounts() {
  const s = useStore();
  const { t, locale } = useT();
  const { bal, total } = useBalances();
  const [showArch, setShowArch] = useState(false);
  const [edit, setEdit] = useState(false);
  const list = accountsSorted(s.accounts);
  const active = list.filter((a) => !a.archived);
  const archived = list.filter((a) => a.archived);
  const hide = false; // privacy mode only applies to Home: this screen is for managing accounts
  const base = s.settings.baseCurrency;
  const day = useToday();
  const monthlyOn = s.settings.monthlyCardView !== false;
  const monthly = useMemo(() => monthlyProjection(s, undefined, day), [s, day]);

  const positive = active.filter((a) => a.includeInTotal).map((a) => ({ a, v: Math.max(toBase(s, bal.get(a.id) ?? 0, a.currency), 0) })).filter((p) => p.v > 0).sort((x, y) => y.v - x.v);
  const posTotal = positive.reduce((x, p) => x + p.v, 0) || 1;

  const commit = (ids: string[]) =>
    setState((st) => ({ ...st, accounts: st.accounts.map((a) => (ids.includes(a.id) ? { ...a, order: ids.indexOf(a.id) } : a)) }));

  const row = (id: string) => {
    const a = s.accounts.find((x) => x.id === id)!;
    const v = bal.get(a.id) ?? 0;
    const cardRow = monthlyOn ? monthly.cards.find((c) => c.accountId === a.id) : undefined;
    const cardMissing = cardRow?.status === 'missing' || cardRow?.status === 'negative' || (!!cardRow && cardRow.amount === null);
    const foreign = a.currency !== base;
    return (
      <div className="row" key={a.id} style={{ gap: 0 }}>
        <button className="item grow" onClick={() => { if (!edit) navigate(`/tx?acc=${a.id}`); }} style={{ borderTop: 0 }}>
          <Bubble icon={a.icon} color={a.color} size={44} />
          <div className="grow">
            <div className="t">{a.name}</div>
            <div className="s">{a.currency}{!a.includeInTotal ? ' · ' + t('includeInTotal') + ' ✕' : ''}</div>
          </div>
          <div className="right">
            <div className="amt" style={cardRow && !cardMissing ? { color: 'var(--exp)' } : v < 0 ? { color: 'var(--exp)' } : undefined}>
              {hide ? '••••••' : cardRow ? (cardMissing || cardRow.amount === null ? t('cardUnavailable') : money(-cardRow.amount, a.currency, locale)) : money(v, a.currency, locale)}
            </div>
            {cardRow && !cardMissing && <div className="amt2">{cardRow.source === 'manual' ? t('cardManualMonth') : t('cardBillMonth')}{cardRow.status !== 'fresh' ? ` · ${cardRow.fetchedAt ? t('monthlyStaleNotice', { d: new Date(cardRow.fetchedAt).toLocaleString(locale) }) : t('monthlyStale')}` : ''}</div>}
            {!cardRow && foreign && !hide && <div className="amt2">≈ {money(toBase(s, v, a.currency), base, locale)}</div>}
          </div>
        </button>
        {edit && !a.archived && <span className="handle"><PiDotsSixVerticalBold /></span>}
      </div>
    );
  };

  return (
    <>
      <div className="topbar">
        <h1>{t('accounts')}</h1>
        <button className={'icon-btn' + (edit ? ' on' : ' solid')} onClick={() => setEdit(!edit)} aria-label="edit">{edit ? <PiCheckBold /> : <PiArrowsDownUpBold />}</button>
        <button className="icon-btn solid" onClick={() => openAccountEditor()} aria-label="add"><PiPlusBold /></button>
      </div>

      <div className="balance">
        <div className="lbl">{t('totalBalance')}</div>
        <div className={'val' + (hide ? ' hidden' : '')}>{hide ? '••••••' : money(total, base, locale)}</div>
        {!hide && positive.length > 0 && (
          <>
            <div className="dist">
              {positive.map((p) => <i key={p.a.id} style={{ width: `${(p.v / posTotal) * 100}%`, background: p.a.color, minWidth: 3 }} />)}
            </div>
            <div className="legend">
              {positive.map((p) => (
                <span key={p.a.id}><i style={{ background: p.a.color }} />{p.a.name} {Math.round((p.v / posTotal) * 100)}%</span>
              ))}
            </div>
          </>
        )}
      </div>

      {monthlyOn && <div className="small muted" style={{ padding: '0 16px 10px' }}>{t('accountsMonthlyHint')}</div>}
      <div className="paper" style={{ padding: '2px 12px' }}><MonthlyToggle /></div>

      <div className="qa two">
        <button onClick={() => navigate('/tx?kind=transfer&gran=year')}>
          <span className="set-ico"><PiClockCounterClockwiseBold /></span>
          <span>{t('transferHistory')}</span>
        </button>
        <button onClick={() => openTxEditor({ kind: 'transfer' })}>
          <span className="set-ico" style={{ background: 'var(--xfer-soft)', color: 'var(--xfer)' }}><PiArrowsLeftRightBold /></span>
          <span>{t('newTransfer')}</span>
        </button>
      </div>

      {edit && <div className="hint"><PiHandGrabbingBold /> {t('dragHintList')}</div>}
      <div className="paper flush">
        <Sortable items={active} enabled={edit} onCommit={commit} render={(a) => row(a.id)} itemClass="acc-row" />
      </div>

      {archived.length > 0 && (
        <>
          <button className="section-title" style={{ width: 'calc(100% - 16px)' }} onClick={() => setShowArch(!showArch)}>
            {t('archivedAccounts')} <span className="tag">{archived.length}</span>
            <span className="link">{showArch ? <PiCaretUpBold /> : <PiCaretDownBold />}</span>
          </button>
          {showArch && <div className="paper flush" style={{ opacity: 0.7 }}>{archived.map((a) => row(a.id))}</div>}
        </>
      )}
    </>
  );
}
