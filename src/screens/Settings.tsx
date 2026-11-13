import { useEffect, useMemo, useState } from 'react';
import { PiUserDuotone, PiTranslateDuotone, PiPaletteDuotone, PiCurrencyCircleDollarDuotone, PiArrowsClockwiseBold, PiEyeSlashDuotone, PiCalendarDuotone, PiDownloadSimpleDuotone, PiFileCsvDuotone, PiTrashDuotone, PiHeartDuotone, PiCaretRightBold, PiTagDuotone, PiSwapDuotone, PiCloudCheckDuotone, PiHashDuotone, PiReceiptDuotone, PiShareNetworkDuotone, PiClockCounterClockwiseDuotone, PiVibrateDuotone, PiSquareHalfBottomDuotone, PiSquaresFourDuotone, PiChatTextDuotone, PiMagnifyingGlassBold, PiLockKeyDuotone, PiFingerprintDuotone, PiLightningDuotone, PiSparkleDuotone, PiChatCircleDotsBold } from 'react-icons/pi';
import type { State } from '../lib/types';
import { getState, replaceState, setState, useStore, backupNow } from '../lib/store';
import { useT } from '../i18n';
import { CURRENCIES, initialState, detectLang } from '../lib/defaults';
import { Switch, Seg, confirmDialog, Sheet } from '../components/ui';
import { navigate, openOverlay, toast, closeAllOverlays } from '../lib/nav';
import { importMmBackup } from '../lib/importer';
import { pickFile, saveTextFile, listAutoBackups, readAutoBackup, type BackupEntry } from '../native';
import { today, fold } from '../lib/calc';
import { PinSheet, setPin } from '../components/Lock';
import { ShortcutsSheet } from '../components/Shortcuts';
import { NotifSettingsSheet } from '../components/NotifUI';
import { PluggySettingsSheet } from '../components/PluggyUI';
import { AiSettingsSheet } from '../components/AiUI';
import { clearAiKey } from '../lib/ai-config';
import { biometricAvailable } from '../native';

declare const __APP_VERSION__: string;
function Ico({ children }: { c?: string; children: React.ReactNode }) {
  return <div className="set-ico">{children}</div>;
}

export async function updateRates(failMsg?: string) {
  const s = getState();
  const base = s.settings.baseCurrency;
  const needed = [...new Set([...s.accounts.map((a) => a.currency), ...(s.settings.notif?.on ? ['BRL', 'EUR', 'USD', 'GBP'] : [])].filter((c) => c !== base))];
  const urls = [`https://api.frankfurter.dev/v1/latest?base=${base}`, `https://open.er-api.com/v6/latest/${base}`];
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const j = await r.json();
      const rates = j.rates as Record<string, number>;
      if (!rates) continue;
      const next = { ...s.settings.rates };
      let got = 0;
      for (const c of new Set([...needed, ...Object.keys(next)])) {
        if (rates[c]) { next[c] = 1 / rates[c]; got++; }
      }
      if (!got && needed.length) continue;
      setState((st) => ({ ...st, settings: { ...st.settings, rates: next, ratesUpdated: new Date().toISOString() } }));
      return true;
    } catch { /* try next */ }
  }
  if (failMsg) toast(failMsg);
  return false;
}

export async function exportBackupFile(t: (k: any, v?: Record<string, string>) => string, email = false) {
  try {
    toast(t('backingUp'));
    const { buildBackup } = await import('../lib/backup');
    const json = await buildBackup();
    if (email) await saveTextFile(`kova-backup-${today()}.json`, json, 'application/json', `${t('emailSubject')} ${today()}`, t('emailBody', { d: today() }));
    else await saveTextFile(`kova-backup-${today()}.json`, json, 'application/json', t('exportBackup'));
  } catch {
    toast(t('backupFail'));
  }
}

export function restoreError(t: (k: any) => string, e: unknown) {
  const m = e instanceof Error ? e.message : '';
  toast(m === 'EMPTY' ? t('errEmpty') : m === 'BROKEN' ? t('errBroken') : m === 'NOT_KOVA' ? t('errNotKova') : t('importFail'));
}

export async function applyBackupText(t: (k: any, v?: Record<string, string>) => string, text: string) {
  const { restoreBackup } = await import('../lib/backup');
  const r = await restoreBackup(text);
  await closeAllOverlays();
  navigate('/', true);
  toast(t('restoredN', { t: String(r.txs), a: String(r.accounts) }));
}

export async function restoreFromFile(t: (k: any, v?: Record<string, string>) => string, ask = true) {
  const f = await pickFile('*/*');
  if (!f) return;
  try {
    const text = await f.text();
    if (ask && !(await confirmDialog(t('confirmImport'), t('restoreBackup'), t('cancel'), false))) return;
    await applyBackupText(t, text);
  } catch (e) {
    restoreError(t, e);
  }
}

export async function runMmImport(t: (k: any) => string) {
  const f = await pickFile('*/*');
  if (!f) return;
  const ok = await confirmDialog(t('confirmImport'), t('importBackup'), t('cancel'), false);
  if (!ok) return;
  toast(t('importing'));
  try {
    const buf = await f.arrayBuffer();
    const { state, report, files } = await importMmBackup(buf, getState());
    const { putFile } = await import('../lib/files');
    for (const [id, b] of files) await putFile(id, b);
    replaceState(state);
    toast(`${t('imported')}: ${report.txs} ${t('transactions').toLowerCase()} · ${report.accounts} ${t('accounts').toLowerCase()}`);
    navigate('/', true);
  } catch (e) {
    console.error(e);
    toast(t('importFail'));
  }
}

export function Settings() {
  const s = useStore();
  const { t, locale } = useT();
  const st = s.settings;
  const set = (patch: Partial<State['settings']>) => setState((x) => ({ ...x, settings: { ...x.settings, ...patch } }));
  const used = [...new Set(s.accounts.map((a) => a.currency).filter((c) => c !== st.baseCurrency))];
  const [busy, setBusy] = useState(false);
  const [bioOk, setBioOk] = useState(false);
  useEffect(() => { biometricAvailable().then(setBioOk); }, []);
  const toggleLock = (on: boolean) => {
    if (on) openOverlay((close) => <PinSheet mode="create" close={close} />);
    else openOverlay((close) => <PinSheet mode="verify" close={close} onOk={() => { setPin(null); toast(t('pinOff')); }} />);
  };

  const changeBase = (next: string) => {
    if (next === st.baseCurrency) return;
    const r = st.rates[next] ?? 1; // old base per 1 next
    setState((x) => {
      const rates: Record<string, number> = {};
      for (const [c, v] of Object.entries(x.settings.rates)) if (c !== next) rates[c] = v / r;
      rates[x.settings.baseCurrency] = 1 / r;
      return {
        ...x,
        txs: x.txs.map((tx) => ({ ...tx, base: Math.round(tx.base / r) })),
        categories: x.categories.map((c) => (c.budget ? { ...c, budget: Math.round(c.budget / r) } : c)),
        settings: { ...x.settings, baseCurrency: next, rates },
      };
    });
  };

  const restoreJson = () => restoreFromFile(t);
  const exportCsv = async () => {
    const x = getState();
    const cat = new Map(x.categories.map((c) => [c.id, c.name]));
    const acc = new Map(x.accounts.map((a) => [a.id, a]));
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = [['date', 'type', 'category', 'account', 'amount', 'currency', `amount_${x.settings.baseCurrency}`, 'note', 'tags'].join(',')];
    for (const tx of x.txs) {
      const a = acc.get(tx.accountId);
      rows.push([tx.date, tx.kind, esc(cat.get(tx.categoryId) ?? ''), esc(a?.name ?? ''), (tx.amount / 100).toFixed(2), a?.currency ?? '', (tx.base / 100).toFixed(2), esc(tx.note), esc(tx.tags.join(' '))].join(','));
    }
    for (const tr of x.transfers) {
      rows.push([tr.date, 'transfer', '', esc(`${acc.get(tr.from)?.name ?? t('manualAdjust')} -> ${acc.get(tr.to)?.name ?? t('manualAdjust')}`), (tr.fromAmount / 100).toFixed(2), acc.get(tr.from)?.currency ?? '', '', esc(tr.note), ''].join(','));
    }
    await saveTextFile(`kova-${today()}.csv`, '﻿' + rows.join('\n'), 'text/csv', t('exportCsv'));
  };
  const erase = async () => {
    if (!(await confirmDialog(t('confirmErase'), t('eraseAll'), t('cancel')))) return;
    try {
      await clearAiKey();
    } catch {
      toast(t('aiKeyKept'));
    }
    const fresh = initialState(detectLang());
    replaceState({ ...fresh, settings: { ...fresh.settings, lang: st.lang, theme: st.theme } });
  };

  const editName = () =>
    openOverlay((close) => <NameSheet initial={st.name} onSave={(v) => { set({ name: v }); close(); }} />);

  return (
    <>
      <div className="topbar"><h1>{t('settings')}</h1></div>

      <div className="section-title">{t('profile')}</div>
      <div className="paper flush">
        <button className="setting" onClick={editName}>
          <Ico c="linear-gradient(145deg,#a996ff,#7c5cff)"><PiUserDuotone /></Ico>
          <div className="grow"><div className="t">{t('yourName')}</div><div className="s">{st.name || '—'}</div></div>
          <PiCaretRightBold className="muted" />
        </button>
        <div className="setting">
          <Ico c="linear-gradient(145deg,#6fd3ff,#22b8e6)"><PiTranslateDuotone /></Ico>
          <div className="grow"><div className="t">{t('language')}</div></div>
        </div>
        <div style={{ padding: '0 12px 12px' }}>
          <Seg value={st.lang} onChange={(v) => set({ lang: v })} options={[{ v: 'auto', label: t('auto') }, { v: 'pt', label: 'Português' }, { v: 'en', label: 'English' }]} />
        </div>
        <div className="setting">
          <Ico c="linear-gradient(145deg,#ff9cc8,#ff5fa2)"><PiPaletteDuotone /></Ico>
          <div className="grow"><div className="t">{t('theme')}</div></div>
        </div>
        <div style={{ padding: '0 12px 12px' }}>
          <Seg value={st.theme} onChange={(v) => set({ theme: v })} options={[{ v: 'system', label: t('system') }, { v: 'light', label: t('light') }, { v: 'dark', label: t('dark') }]} />
        </div>
        <div className="setting">
          <Ico c="linear-gradient(145deg,#c3b8d8,#8b86a0)"><PiEyeSlashDuotone /></Ico>
          <div className="grow"><div className="t">{t('hideBalances')}</div></div>
          <Switch on={st.hideBalance} onChange={(v) => set({ hideBalance: v })} />
        </div>
        <div className="setting">
          <Ico><PiLockKeyDuotone /></Ico>
          <div className="grow"><div className="t">{t('appLock')}</div><div className="s">{t('appLockD')}</div></div>
          <Switch on={!!st.pinHash} onChange={toggleLock} />
        </div>
        {st.pinHash && bioOk && (
          <div className="setting">
            <Ico><PiFingerprintDuotone /></Ico>
            <div className="grow"><div className="t">{t('useBiometric')}</div></div>
            <Switch on={!!st.biometric} onChange={(v) => set({ biometric: v })} />
          </div>
        )}
        <div className="setting">
          <Ico><PiSquaresFourDuotone /></Ico>
          <div className="grow"><div className="t">{t('catRows')}</div><div className="s">{t('catRowsD')}</div></div>
        </div>
        <div style={{ padding: '0 12px 12px' }}>
          <Seg value={String(st.catRows ?? 2)} onChange={(v) => set({ catRows: Number(v) })} options={[{ v: '2', label: '2' }, { v: '3', label: '3' }, { v: '4', label: '4' }, { v: '0', label: t('allRows') }]} />
        </div>
        <div className="setting">
          <Ico><PiVibrateDuotone /></Ico>
          <div className="grow"><div className="t">{t('haptics')}</div><div className="s">{t('hapticsD')}</div></div>
          <Switch on={st.haptics !== false} onChange={(v) => set({ haptics: v })} />
        </div>
        <div className="setting">
          <Ico c="linear-gradient(145deg,#ffd36b,#ffb020)"><PiCalendarDuotone /></Ico>
          <div className="grow"><div className="t">{t('weekStartsOn')}</div></div>
          <Seg value={String(st.weekStart) as '0' | '1'} onChange={(v) => set({ weekStart: Number(v) as 0 | 1 })} options={[{ v: '1', label: t('monday') }, { v: '0', label: t('sunday') }]} />
        </div>
      </div>

      <div className="section-title">{t('currency')}</div>
      <div className="paper flush">
        <label className="setting">
          <Ico c="linear-gradient(145deg,#7ce8b3,#18b47b)"><PiCurrencyCircleDollarDuotone /></Ico>
          <div className="grow"><div className="t">{t('baseCurrency')}</div></div>
          <select className="v" value={st.baseCurrency} onChange={(e) => changeBase(e.target.value)} style={{ border: 0, background: 'var(--sunk)', borderRadius: 12, padding: '8px 10px', fontWeight: 600 }}>
            {[...new Set([st.baseCurrency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        {used.length > 0 && (
          <div style={{ padding: '4px 12px 12px' }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <PiSwapDuotone className="muted" />
              <b className="grow small">{t('exchangeRates')}</b>
              <button className="tag lilac" disabled={busy} onClick={async () => { setBusy(true); const ok = await updateRates(t('ratesFail')); setBusy(false); if (ok) toast(t('ratesUpdated')); }}>
                <PiArrowsClockwiseBold /> {t('updateRates')}
              </button>
            </div>
            {used.map((c) => (
              <label key={c} className="field" style={{ boxShadow: 'none', background: 'var(--sunk)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <b style={{ whiteSpace: 'nowrap' }}>1 {c} =</b>
                <input
                  inputMode="decimal"
                  defaultValue={st.rates[c] ? String(+st.rates[c].toFixed(4)) : ''}
                  key={st.ratesUpdated + c}
                  onBlur={(e) => {
                    const v = parseFloat(e.target.value.replace(',', '.'));
                    if (v > 0) set({ rates: { ...st.rates, [c]: v } });
                  }}
                />
                <b>{st.baseCurrency}</b>
              </label>
            ))}
            {st.ratesUpdated && <div className="small muted" style={{ padding: '0 4px' }}>{t('ratesUpdated')}: {new Date(st.ratesUpdated).toLocaleString(locale)}</div>}
          </div>
        )}
        <div className="setting">
          <Ico><PiHashDuotone /></Ico>
          <div className="grow"><div className="t">{t('showTags')}</div><div className="s">{t('showTagsD')}</div></div>
          <Switch on={st.showTags !== false} onChange={(v) => set({ showTags: v })} />
        </div>
        <button className="setting" onClick={() => openOverlay(() => <TagsSheet />)}>
          <Ico><PiHashDuotone /></Ico>
          <div className="grow"><div className="t">{t('manageTags')}</div></div>
          <PiCaretRightBold className="muted" />
        </button>
        <div className="setting">
          <Ico><PiLightningDuotone /></Ico>
          <div className="grow"><div className="t">{t('shortcutsOn')}</div><div className="s">{t('shortcutsOnD')}</div></div>
          <Switch on={st.shortcutsOn !== false} onChange={(v) => set({ shortcutsOn: v })} />
        </div>
        {st.shortcutsOn !== false && <button className="setting" onClick={() => openOverlay(() => <ShortcutsSheet />)}>
          <Ico><PiLightningDuotone /></Ico>
          <div className="grow"><div className="t">{t('shortcuts')}</div><div className="s">{t('shortcutsD')}</div></div>
          <PiCaretRightBold className="muted" />
        </button>}
        <button className="setting" onClick={() => openOverlay(() => <NotesSheet />)}>
          <Ico><PiChatTextDuotone /></Ico>
          <div className="grow"><div className="t">{t('manageNotes')}</div><div className="s">{t('manageNotesD')}</div></div>
          <PiCaretRightBold className="muted" />
        </button>
        <button className="setting" onClick={() => navigate('/bills')}>
          <Ico><PiReceiptDuotone /></Ico>
          <div className="grow"><div className="t">{t('fixedBills')}</div></div>
          <PiCaretRightBold className="muted" />
        </button>
        <button className="setting" onClick={() => navigate('/categories')}>
          <Ico c="linear-gradient(145deg,#e7a1ff,#b57bff)"><PiTagDuotone /></Ico>
          <div className="grow"><div className="t">{t('manageCategories')}</div></div>
          <PiCaretRightBold className="muted" />
        </button>
      </div>

      <div className="section-title">{t('autoEntry')}</div>
      <div className="paper flush">
        <button className="setting" onClick={() => openOverlay(() => <NotifSettingsSheet />)}>
          <Ico><PiLightningDuotone /></Ico>
          <div className="grow"><div className="t">{t('autoEntry')}</div><div className="s">{st.notif?.on ? Object.values(st.notif.apps).filter((a) => a.on).map((a) => a.label).join(', ') || t('autoEntryD') : t('autoEntryD')}</div></div>
          <PiCaretRightBold className="muted" />
        </button>
      </div>

      <div className="section-title">{t('pluggyTitle')}</div>
      <div className="paper flush">
        <button className="setting" onClick={() => openOverlay(() => <PluggySettingsSheet />)}>
          <Ico><PiLightningDuotone /></Ico>
          <div className="grow"><div className="t">{t('pluggyTitle')}</div><div className="s">{t('pluggyD')}</div></div>
          <PiCaretRightBold className="muted" />
        </button>
      </div>

      <div className="section-title">{t('aiTitle')}</div>
      <div className="paper flush">
        <button className="setting" onClick={() => openOverlay((close) => <AiSettingsSheet onDone={close} />)}>
          <Ico><PiSparkleDuotone /></Ico>
          <div className="grow"><div className="t">{t('aiTitle')}</div><div className="s">{st.ai?.model || t('aiD')}</div></div>
          <PiCaretRightBold className="muted" />
        </button>
        <button className="setting" onClick={() => navigate('/chat')}>
          <Ico><PiChatCircleDotsBold /></Ico>
          <div className="grow"><div className="t">{t('chatTitle')}</div></div>
          <PiCaretRightBold className="muted" />
        </button>
      </div>

      <div className="section-title">{t('widget')}</div>
      <div className="paper flush">
        <div className="setting">
          <Ico><PiSquareHalfBottomDuotone /></Ico>
          <div className="grow"><div className="t">{t('widgetShow')}</div><div className="s">{t('widgetShowD')}</div></div>
          <Switch on={st.widgetHide !== true} onChange={(v) => set({ widgetHide: !v })} />
        </div>
        <div className="small muted" style={{ padding: '0 16px 14px' }}>{t('widgetHow')}</div>
      </div>

      <div className="section-title">{t('autoBackup')}</div>
      <div className="paper flush">
        <div className="setting">
          <Ico><PiCloudCheckDuotone /></Ico>
          <div className="grow">
            <div className="t">{t('autoBackup')}</div>
            <div className="s">{t('autoBackupD')}</div>
            {st.lastBackup && <div className="s">{t('lastBackup')}: {new Date(st.lastBackup).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}</div>}
          </div>
          <Switch on={st.autoBackup} onChange={(v) => set({ autoBackup: v })} />
        </div>
        <button className="setting" disabled={busy} onClick={async () => { setBusy(true); toast(t('backingUp')); const ok = await backupNow(); setBusy(false); toast(ok ? t('backupDone') : t('backupFail')); }}>
          <Ico><PiArrowsClockwiseBold /></Ico>
          <div className="grow"><div className="t">{busy ? t('backingUp') : t('backupNow')}</div></div>
        </button>
        <button className="setting" onClick={() => exportBackupFile(t, true)}>
          <Ico><PiShareNetworkDuotone /></Ico>
          <div className="grow"><div className="t">{t('shareBackup')}</div><div className="s">{t('shareBackupD')}</div></div>
        </button>
        <button className="setting" onClick={() => openOverlay(() => <AutoBackups />)}>
          <Ico><PiClockCounterClockwiseDuotone /></Ico>
          <div className="grow"><div className="t">{t('restoreAuto')}</div></div>
          <PiCaretRightBold className="muted" />
        </button>
      </div>

      <div className="section-title">{t('data')}</div>
      <div className="paper flush">
        <button className="setting" onClick={() => runMmImport(t)}>
          <Ico c="linear-gradient(145deg,#a996ff,#5b4bdb)"><PiDownloadSimpleDuotone /></Ico>
          <div className="grow"><div className="t">{t('importOther')}</div><div className="s">{t('importOtherD')}</div></div>
        </button>
        <button className="setting" onClick={restoreJson}>
          <Ico c="linear-gradient(145deg,#6fd3ff,#3d8bff)"><PiDownloadSimpleDuotone /></Ico>
          <div className="grow"><div className="t">{t('restoreBackup')}</div><div className="s">{t('restoreBackupD')}</div></div>
        </button>
        <button className="setting" onClick={exportCsv}>
          <Ico c="linear-gradient(145deg,#ffd36b,#ff8a4c)"><PiFileCsvDuotone /></Ico>
          <div className="grow"><div className="t">{t('exportCsv')}</div><div className="s">{t('exportCsvD')}</div></div>
        </button>
        <button className="setting" onClick={erase}>
          <Ico c="linear-gradient(145deg,#ff9aa6,#f0445a)"><PiTrashDuotone /></Ico>
          <div className="grow"><div className="t" style={{ color: 'var(--exp)' }}>{t('eraseAll')}</div><div className="s">{t('eraseAllD')}</div></div>
        </button>
      </div>

      <div className="section-title">{t('about')}</div>
      <div className="paper flush">
        <div className="setting">
          <Ico c="linear-gradient(145deg,#ff9cc8,#e056fd)"><PiHeartDuotone /></Ico>
          <div className="grow"><div className="t">Kova</div><div className="s">{t('version')} {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'}</div></div>
        </div>
      </div>
    </>
  );
}

function TagsSheet() {
  const s = useStore();
  const { t } = useT();
  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of s.txs) for (const g of x.tags) m.set(g, (m.get(g) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [s.txs]);
  return (
    <Sheet title={t('manageTags')}>
      <div className="sheet-b">
        {tags.length === 0 && <div className="empty">{t('noTags')}</div>}
        <div className="paper flush">
          {tags.map(([g, n]) => (
            <button key={g} className="setting" onClick={() => openOverlay((close) => <TagEdit tag={g} close={close} />)}>
              <Ico><PiHashDuotone /></Ico>
              <div className="grow"><div className="t">{g}</div><div className="s">{n} {t('transactions').toLowerCase()}</div></div>
              <PiCaretRightBold className="muted" />
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

function NotesSheet() {
  const s = useStore();
  const { t } = useT();
  const [q, setQ] = useState('');
  const notes = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of s.txs) if (x.note.trim()) m.set(x.note.trim(), (m.get(x.note.trim()) ?? 0) + 1);
    for (const x of s.transfers) if (x.note.trim()) m.set(x.note.trim(), (m.get(x.note.trim()) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [s.txs, s.transfers]);
  const shown = notes.filter(([n]) => !q || fold(n).includes(fold(q)));
  return (
    <Sheet title={t('manageNotes')}>
      <div className="sheet-b">
        <div className="search" style={{ margin: '0 0 12px' }}><PiMagnifyingGlassBold /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} /></div>
        {shown.length === 0 && <div className="empty">{t('noNotes')}</div>}
        <div className="paper flush">
          {shown.slice(0, 300).map(([n, c]) => (
            <button key={n} className="setting" onClick={() => openOverlay((close) => <NoteEdit note={n} count={c} close={close} />)}>
              <Ico><PiChatTextDuotone /></Ico>
              <div className="grow"><div className="t" style={{ whiteSpace: 'normal' }}>{n}</div><div className="s">{c} {t('transactions').toLowerCase()}</div></div>
              <PiCaretRightBold className="muted" />
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

function NoteEdit({ note, count, close }: { note: string; count: number; close: () => void }) {
  const { t } = useT();
  const [v, setV] = useState(note);
  const apply = (nv: string) =>
    setState((st) => ({
      ...st,
      txs: st.txs.map((x) => (x.note.trim() === note ? { ...x, note: nv } : x)),
      transfers: st.transfers.map((x) => (x.note.trim() === note ? { ...x, note: nv } : x)),
    }));
  const save = () => { apply(v.trim()); toast(t('savedOk')); close(); };
  const clear = async () => {
    if (!(await confirmDialog(t('clearNote') + ` (${count})`, t('clearNote'), t('cancel')))) return;
    apply('');
    close();
  };
  const see = async () => { await closeAllOverlays(); navigate(`/tx?kind=all&all=1&q=${encodeURIComponent(note)}`); };
  return (
    <Sheet title={t('manageNotes')} footer={<><button className="btn danger" onClick={clear}>{t('clearNote')}</button><button className="btn primary" onClick={save}>{t('save')}</button></>}>
      <div className="sheet-b">
        <label className="field"><span>{t('note')}</span><input value={v} type="text" inputMode="text" onChange={(e) => setV(e.target.value)} /></label>
        <div className="small muted" style={{ margin: '0 6px 12px' }}>{t('renameNoteHint')}</div>
        <button className="btn ghost" style={{ width: '100%' }} onClick={see}><PiMagnifyingGlassBold /> {t('seeTransactions')} ({count})</button>
      </div>
    </Sheet>
  );
}

function TagEdit({ tag, close }: { tag: string; close: () => void }) {
  const { t } = useT();
  const [v, setV] = useState(tag);
  const rename = () => {
    const nv = v.trim().replace(/^#/, '');
    if (!nv) return;
    setState((st) => ({ ...st, txs: st.txs.map((x) => (x.tags.includes(tag) ? { ...x, tags: [...new Set(x.tags.map((g) => (g === tag ? nv : g)))] } : x)) }));
    toast(t('savedOk'));
    close();
  };
  const remove = async () => {
    if (!(await confirmDialog(t('confirmDelete'), t('delete'), t('cancel')))) return;
    setState((st) => ({ ...st, txs: st.txs.map((x) => (x.tags.includes(tag) ? { ...x, tags: x.tags.filter((g) => g !== tag) } : x)) }));
    close();
  };
  return (
    <Sheet title={'#' + tag} footer={<><button className="btn danger" onClick={remove}>{t('delete')}</button><button className="btn primary" onClick={rename}>{t('save')}</button></>}>
      <div className="sheet-b">
        <label className="field"><span>{t('name')}</span><input value={v} onChange={(e) => setV(e.target.value)} /></label>
        <div className="small muted" style={{ margin: '0 6px' }}>{t('renameTagHint')}</div>
      </div>
    </Sheet>
  );
}

function AutoBackups() {
  const { t, locale } = useT();
  const [list, setList] = useState<BackupEntry[] | null>(null);
  useEffect(() => { listAutoBackups().then(setList); }, []);
  const restore = async (e: BackupEntry) => {
    if (!(await confirmDialog(t('confirmImport'), t('restoreBackup'), t('cancel'), false))) return;
    try {
      toast(t('importing'));
      await applyBackupText(t, (await readAutoBackup(e)) ?? '');
    } catch (err) {
      restoreError(t, err);
    }
  };
  return (
    <Sheet title={t('restoreAuto')}>
      <div className="sheet-b">
        {list && list.length === 0 && <div className="empty">{t('noBackups')}</div>}
        <div className="paper flush">
          {(list ?? []).map((e) => {
            const d = e.mtime ? new Date(e.mtime) : e.name.match(/(\d{4}-\d{2}-\d{2})/) ? new Date(e.name.match(/(\d{4}-\d{2}-\d{2})/)![1] + 'T12:00') : null;
            return (
              <button key={e.where + e.path} className="setting" onClick={() => restore(e)}>
                <Ico><PiClockCounterClockwiseDuotone /></Ico>
                <div className="grow">
                  <div className="t">{d ? d.toLocaleString(locale, e.mtime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'full' }) : e.name}</div>
                  <div className="s">{e.where === 'app' ? t('inApp') : t('inDocs')}{e.size ? ` · ${(e.size / 1048576).toFixed(1)} MB` : ''}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}

function NameSheet({ initial, onSave }: { initial: string; onSave: (v: string) => void }) {
  const { t } = useT();
  const [v, setV] = useState(initial);
  return (
    <Sheet title={t('yourName')} footer={<button className="btn grad" onClick={() => onSave(v.trim())}>{t('save')}</button>}>
      <div className="sheet-b">
        <label className="field"><span>{t('name')}</span><input autoFocus value={v} onChange={(e) => setV(e.target.value)} /></label>
      </div>
    </Sheet>
  );
}
