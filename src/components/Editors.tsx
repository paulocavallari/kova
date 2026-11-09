import { useMemo, useState } from 'react';
import { PiTrashBold, PiArchiveBold, PiMagnifyingGlassBold, PiCheckBold } from 'react-icons/pi';
import type { Account, Category, Kind, Transfer } from '../lib/types';
import { setState, useStore } from '../lib/store';
import { ICONS, ICON_GROUPS, PALETTE } from '../lib/icons';
import { useT } from '../i18n';
import { Bubble, Sheet, Switch, confirmDialog } from './ui';
import { openOverlay, toast } from '../lib/nav';
import { balances, uid, ADJ, today } from '../lib/calc';
import { CURRENCIES } from '../lib/defaults';
import { isEssential } from '../lib/report';

function IconColorPicker({ icon, color, setIcon, setColor }: { icon: string; color: string; setIcon: (s: string) => void; setColor: (s: string) => void }) {
  const { t } = useT();
  const [q, setQ] = useState('');
  const keys = useMemo(() => {
    if (!q) return [...new Set(Object.values(ICON_GROUPS).flat())];
    return Object.keys(ICONS).filter((k) => k.includes(q.toLowerCase().trim()));
  }, [q]);
  return (
    <>
      <div className="small muted" style={{ fontWeight: 600, margin: '14px 4px 10px' }}>{t('color')}</div>
      <div className="swatches">
        {PALETTE.map((c) => (
          <button key={c} className={c === color ? 'on' : ''} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
        ))}
      </div>
      <div className="small muted" style={{ fontWeight: 600, margin: '18px 4px 10px' }}>{t('icon')}</div>
      <div className="search" style={{ height: 44 }}>
        <PiMagnifyingGlassBold />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('iconsSearch') + ' (car, home, food…)'} />
      </div>
      <div className="igrid">
        {keys.map((k) => {
          const I = ICONS[k];
          return (
            <button key={k} className={k === icon ? 'on' : ''} style={k === icon ? { background: color } : undefined} onClick={() => setIcon(k)} aria-label={k}>
              <I />
            </button>
          );
        })}
      </div>
    </>
  );
}

// ---------------- Category ----------------
export function openCategoryEditor(cat?: Category, kind: Kind = 'expense') {
  openOverlay((close) => <CategoryEditor cat={cat} kind={kind} close={close} />);
}

function CategoryEditor({ cat, kind, close }: { cat?: Category; kind: Kind; close: () => void }) {
  const s = useStore();
  const { t } = useT();
  const [name, setName] = useState(cat?.name ?? '');
  const [icon, setIcon] = useState(cat?.icon ?? 'shopping-bag');
  const [color, setColor] = useState(cat?.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)]);
  const [budget, setBudget] = useState(cat?.budget ? String(cat.budget / 100) : '');
  const [essential, setEssential] = useState(isEssential(cat ?? undefined));
  const used = cat ? s.txs.some((x) => x.categoryId === cat.id) : false;

  const save = () => {
    if (!name.trim()) return;
    const b = Math.round(parseFloat(budget.replace(',', '.')) * 100);
    const c: Category = {
      id: cat?.id ?? uid(), name: name.trim(), kind: cat?.kind ?? kind, icon, color,
      budget: b > 0 ? b : undefined, archived: cat?.archived ?? false, essential,
      order: cat?.order ?? s.categories.filter((x) => x.kind === kind).length,
    };
    setState((st) => ({ ...st, categories: cat ? st.categories.map((x) => (x.id === c.id ? c : x)) : [...st.categories, c] }));
    toast(t('savedOk'));
    close();
  };
  const archive = () => {
    setState((st) => ({ ...st, categories: st.categories.map((x) => (x.id === cat!.id ? { ...x, archived: !x.archived } : x)) }));
    close();
  };
  const remove = async () => {
    if (!(await confirmDialog(t('confirmDelete'), t('delete'), t('cancel')))) return;
    setState((st) => ({ ...st, categories: st.categories.filter((x) => x.id !== cat!.id) }));
    close();
  };

  return (
    <Sheet
      title={cat ? t('editCategory') : t('newCategory')}
      footer={<button className="btn grad" onClick={save}><PiCheckBold /> {t('save')}</button>}
      actions={cat && (
        <button className="icon-btn solid" style={{ width: 40, height: 40, boxShadow: 'none', background: 'var(--sunk)' }} onClick={used ? archive : remove} aria-label="archive">
          {used ? <PiArchiveBold /> : <PiTrashBold />}
        </button>
      )}
    >
      <div className="sheet-b">
        <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 16px' }}>
          <Bubble icon={icon} color={color} size={84} round />
        </div>
        <label className="field"><span>{t('name')}</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        {(cat?.kind ?? kind) === 'expense' && (
          <label className="field">
            <span>{t('budget')} ({s.settings.baseCurrency})</span>
            <input inputMode="decimal" value={budget} placeholder={t('budgetHint')} onChange={(e) => setBudget(e.target.value)} />
          </label>
        )}
        {(cat?.kind ?? kind) === 'expense' && (
          <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="grow"><b style={{ fontWeight: 600 }}>{t('essential')}</b><div className="small muted">{t('essentialD')}</div></div>
            <Switch on={essential} onChange={setEssential} />
          </div>
        )}
        {cat?.archived && <div className="tag lilac" style={{ margin: '4px 4px 0' }}>{t('archived')}</div>}
        <IconColorPicker icon={icon} color={color} setIcon={setIcon} setColor={setColor} />
      </div>
    </Sheet>
  );
}

// ---------------- Account ----------------
export function openAccountEditor(acc?: Account) {
  openOverlay((close) => <AccountEditor acc={acc} close={close} />);
}

function AccountEditor({ acc, close }: { acc?: Account; close: () => void }) {
  const s = useStore();
  const { t } = useT();
  const current = acc ? balances(s).get(acc.id) ?? 0 : 0;
  const [name, setName] = useState(acc?.name ?? '');
  const [icon, setIcon] = useState(acc?.icon ?? 'wallet');
  const [color, setColor] = useState(acc?.color ?? '#7C5CFF');
  const [currency, setCurrency] = useState(acc?.currency ?? s.settings.baseCurrency);
  const [bal, setBal] = useState(acc && current !== 0 ? (current / 100).toFixed(2).replace('.', ',') : '');
  const [include, setInclude] = useState(acc?.includeInTotal ?? true);
  const used = acc ? s.txs.some((x) => x.accountId === acc.id) || s.transfers.some((x) => x.from === acc.id || x.to === acc.id) : false;

  const save = () => {
    if (!name.trim()) return;
    const target = Math.round(parseFloat((bal || '0').replace(',', '.')) * 100) || 0;
    const a: Account = {
      id: acc?.id ?? uid(), name: name.trim(), icon, color, currency, includeInTotal: include,
      archived: acc?.archived ?? false, order: acc?.order ?? s.accounts.length,
      initial: acc ? acc.initial : target,
      note: acc?.note,
    };
    const diff = acc ? target - current : 0;
    const adj: Transfer[] = diff ? [{
      id: uid(), from: diff > 0 ? ADJ : a.id, to: diff > 0 ? a.id : ADJ, fromAmount: Math.abs(diff), toAmount: Math.abs(diff),
      date: today(), note: t('manualAdjust'), created: new Date().toISOString(),
    }] : [];
    setState((st) => {
      const live = acc ? st.accounts.find((x) => x.id === acc.id) : undefined;
      const pluggy = live?.pluggy ? { ...live.pluggy } : undefined;
      const nameEdited = !!acc && name.trim() !== acc.name;
      if (pluggy && nameEdited) pluggy.nameCustomized = true;
      const saved: Account = pluggy
        ? { ...a, name: nameEdited ? name.trim() : live!.name, pluggy }
        : a;
      return { ...st, accounts: acc ? st.accounts.map((x) => (x.id === a.id ? saved : x)) : [...st.accounts, saved], transfers: [...adj, ...st.transfers] };
    });
    if (diff) toast(t('adjustSaved'));
    toast(t('savedOk'));
    close();
  };
  const archive = () => {
    setState((st) => ({ ...st, accounts: st.accounts.map((x) => (x.id === acc!.id ? { ...x, archived: !x.archived } : x)) }));
    close();
  };
  const remove = async () => {
    if (!(await confirmDialog(t('confirmDelete'), t('delete'), t('cancel')))) return;
    setState((st) => ({ ...st, accounts: st.accounts.filter((x) => x.id !== acc!.id) }));
    close();
  };

  return (
    <Sheet
      title={acc ? t('editAccount') : t('newAccount')}
      footer={
        <>
          {acc && (
            <button className="btn ghost" onClick={used ? archive : remove}>
              {used ? <PiArchiveBold /> : <PiTrashBold />} {used ? (acc.archived ? t('unarchive') : t('archive')) : t('delete')}
            </button>
          )}
          <button className="btn grad" onClick={save}><PiCheckBold /> {t('save')}</button>
        </>
      }
    >
      <div className="sheet-b">
        <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 16px' }}>
          <Bubble icon={icon} color={color} size={84} round />
        </div>
        <label className="field"><span>{t('name')}</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 10 }}>
          <label className="field">
            <span>{acc ? t('adjustBalance') : t('initialBalance')}</span>
            <input inputMode="decimal" value={bal} placeholder="0,00" onChange={(e) => setBal(e.target.value)} />
            {acc && <small className="muted" style={{ display: 'block', fontSize: 11.5, marginTop: 4 }}>{t('adjustHint')}</small>}
          </label>
          <label className="field">
            <span>{t('currency')}</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={used}>
              {[...new Set([currency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
        </div>
        <div className="field" style={{ display: 'flex', alignItems: 'center' }}>
          <b style={{ flex: 1, fontWeight: 600 }}>{t('includeInTotal')}</b>
          <Switch on={include} onChange={setInclude} />
        </div>
        <IconColorPicker icon={icon} color={color} setIcon={setIcon} setColor={setColor} />
      </div>
    </Sheet>
  );
}
