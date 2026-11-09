import { useEffect, useState } from 'react';
import { PiHouse, PiHouseFill, PiWallet, PiWalletFill, PiChartPieSlice, PiChartPieSliceFill, PiSquaresFour, PiSquaresFourFill, PiGearSix, PiGearSixFill, PiPlusBold, PiDownloadSimpleBold, PiSparkleBold, PiCloudArrowDownBold, PiClockCounterClockwiseBold } from 'react-icons/pi';
import { isLoaded, loadState, setState, useStore, getState } from './lib/store';
import { useT, resolveLang } from './i18n';
import { goTab, useRoute, useOverlays } from './lib/nav';
import { OverlayHost, Toast } from './components/ui';
import { openTxEditor } from './components/TxEditor';
import { Home } from './screens/Home';
import { Accounts } from './screens/Accounts';
import { Charts } from './screens/Charts';
import { Categories } from './screens/Categories';
import { Settings, runMmImport, updateRates, restoreFromFile } from './screens/Settings';
import { Transactions } from './screens/Transactions';
import { Bills } from './screens/Bills';
import { setStatusBar, setHaptics, takeCrashNote, listAutoBackups, readAutoBackup, initDeepLinks, type BackupEntry } from './native';
import { launchShortcut } from './components/Shortcuts';
import { LockScreen } from './components/Lock';
import { applyBackupText, restoreError } from './screens/Settings';
import { openOverlay, toast, getAddKind, navigate } from './lib/nav';
import { startPluggyAutoSync } from './lib/pluggy';
import { Sheet } from './components/ui';

function useTheme() {
  const s = useStore();
  const [sysDark, setSysDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const fn = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq?.addEventListener?.('change', fn);
    return () => mq?.removeEventListener?.('change', fn);
  }, []);
  const dark = s.settings.theme === 'dark' || (s.settings.theme === 'system' && sysDark);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.lang = resolveLang(s.settings.lang) === 'pt' ? 'pt-BR' : 'en';
  }, [dark, s.settings.lang]);
  return dark;
}

/** Status bar icons: light over the violet hero (home / welcome), otherwise follow the theme. */
function useSystemBars(dark: boolean, onboarded: boolean) {
  const r = useRoute();
  const ovs = useOverlays();
  const overHero = !onboarded || (r.path === '/' && ovs.length === 0);
  useEffect(() => {
    const bg = dark ? '#0b0b13' : '#f4f5fa';
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', overHero ? (dark ? '#140c3d' : '#24127a') : bg);
    setStatusBar(overHero || dark, bg, dark);
  }, [dark, overHero]);
}

export function App() {
  const [ready, setReady] = useState(isLoaded());
  useEffect(() => {
    loadState().then(() => setReady(true));
  }, []);
  const dark = useTheme();
  if (!ready) return null;
  return <Shell dark={dark} />;
}

function Shell({ dark }: { dark: boolean }) {
  const s = useStore();
  useSystemBars(dark, s.settings.onboarded);
  useEffect(() => { setHaptics(s.settings.haptics !== false); }, [s.settings.haptics]);
  useEffect(() => {
    initDeepLinks((url) => {
      try {
        const st = getState();
        if (!st.settings.onboarded) return;
        const u = new URL(url);
        const what = u.host || u.pathname.replace(/^\/+/, '');
        if (what === 'notifsettings') {
          const pkg = u.searchParams.get('enable') ?? undefined;
          import('./components/NotifUI').then((m) => openOverlay(() => <m.NotifSettingsSheet enable={pkg} />));
        } else if (what === 'notif') {
          const id = u.searchParams.get('id') ?? '';
          import('./lib/notif').then(async (n) => {
            await n.syncNotifs();
            const it = n.findPending(id);
            if (it) (await import('./components/NotifUI')).editNotif(it);
            else navigate('/', true);
          });
        } else if (what === 'add') {
          const sc = (st.shortcuts ?? []).find((x) => x.id === u.searchParams.get('sc'));
          if (sc) launchShortcut(sc);
          else openTxEditor({ kind: (u.searchParams.get('kind') as 'expense' | 'income') || 'expense' });
        } else navigate('/', true);
      } catch { /* ignore */ }
    });
  }, []);
  useEffect(() => {
    if (s.settings.onboarded) import('./lib/notif').then((n) => n.startNotifSync());
  }, [s.settings.onboarded]);
  useEffect(() => {
    if (!s.settings.onboarded) return;
    return startPluggyAutoSync(() => getState(), (fn) => setState(fn));
  }, [s.settings.onboarded]);
  useEffect(() => {
    takeCrashNote().then((txt) => { if (txt) openOverlay(() => <CrashSheet text={txt} />); });
  }, []);
  useEffect(() => {
    const last = s.settings.ratesUpdated ? new Date(s.settings.ratesUpdated).getTime() : 0;
    if (s.settings.onboarded && Date.now() - last > 12 * 3600e3 && s.accounts.some((a) => a.currency !== s.settings.baseCurrency)) updateRates();
  }, []);
  const [locked, setLocked] = useState(() => !!s.settings.pinHash);
  useEffect(() => {
    let hiddenAt = 0;
    const fn = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (getState().settings.pinHash && hiddenAt && Date.now() - hiddenAt > 30_000) setLocked(true);
    };
    document.addEventListener('visibilitychange', fn);
    return () => document.removeEventListener('visibilitychange', fn);
  }, []);
  return (
    <>
      {s.settings.onboarded ? <Main /> : <Welcome />}
      <OverlayHost />
      <Toast />
      {locked && s.settings.pinHash && <LockScreen onUnlock={() => setLocked(false)} />}
    </>
  );
}

function Main() {
  const { t } = useT();
  const r = useRoute();
  const path = r.path;
  const isTab = ['/', '/accounts', '/charts', '/categories', '/settings'].includes(path);
  let screen;
  if (path === '/accounts') screen = <Accounts />;
  else if (path === '/charts') screen = <Charts />;
  else if (path === '/categories') screen = <Categories />;
  else if (path === '/settings') screen = <Settings />;
  else if (path === '/tx') screen = <Transactions key={r.query.toString()} />;
  else if (path === '/bills') screen = <Bills />;
  else screen = <Home />;

  const tabs = [
    { p: '/', icon: PiHouse, on: PiHouseFill, l: t('home') },
    { p: '/accounts', icon: PiWallet, on: PiWalletFill, l: t('accounts') },
    { p: '/charts', icon: PiChartPieSlice, on: PiChartPieSliceFill, l: t('charts') },
    { p: '/categories', icon: PiSquaresFour, on: PiSquaresFourFill, l: t('categories') },
    { p: '/settings', icon: PiGearSix, on: PiGearSixFill, l: t('settings') },
  ];
  const showFab = path === '/' || path === '/accounts' || path === '/tx' || path === '/bills';
  const accFromRoute = path === '/tx' ? r.query.get('acc') ?? undefined : undefined;

  return (
    <>
      <div className={'app' + (isTab ? '' : ' sub') + (path === '/' ? ' home' : '')}>{screen}</div>
      {showFab && (
        <button className="fab" style={!isTab ? { bottom: 'calc(20px + var(--safe-bottom))' } : undefined} onClick={() => openTxEditor({ accountId: accFromRoute, kind: getAddKind() })} aria-label="add">
          <PiPlusBold />
        </button>
      )}
      {isTab && (
        <nav className="nav">
          {tabs.map((x) => {
            const I = path === x.p ? x.on : x.icon;
            return (
              <button key={x.p} className={path === x.p ? 'on' : ''} onClick={() => goTab(x.p)}>
                <I />
                <span>{x.l}</span>
              </button>
            );
          })}
        </nav>
      )}
    </>
  );
}

function Welcome() {
  const { t, locale } = useT();
  const [found, setFound] = useState<BackupEntry | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => { listAutoBackups().then((l) => setFound(l[0] ?? null)).catch(() => setFound(null)); }, []);
  const restoreFound = async () => {
    if (!found) return;
    setBusy(true);
    try { await applyBackupText(t, (await readAutoBackup(found)) ?? ''); } catch (e) { restoreError(t, e); }
    setBusy(false);
  };
  return (
    <div className="welcome">
      <div className="art">
        <svg viewBox="0 0 300 250" width="300" height="250" aria-hidden>
          <rect x="40" y="30" width="220" height="150" rx="30" fill="rgba(255,255,255,.12)" stroke="rgba(255,255,255,.25)" />
          <circle cx="110" cy="105" r="44" fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="16" />
          <circle cx="110" cy="105" r="44" fill="none" stroke="#ffd36b" strokeWidth="16" strokeDasharray="110 300" transform="rotate(-90 110 105)" />
          <circle cx="110" cy="105" r="44" fill="none" stroke="#3fd28f" strokeWidth="16" strokeDasharray="70 300" strokeDashoffset="-114" transform="rotate(-90 110 105)" />
          <circle cx="110" cy="105" r="44" fill="none" stroke="#ff7ab6" strokeWidth="16" strokeDasharray="60 300" strokeDashoffset="-188" transform="rotate(-90 110 105)" />
          <rect x="175" y="72" width="62" height="10" rx="5" fill="rgba(255,255,255,.85)" />
          <rect x="175" y="92" width="44" height="8" rx="4" fill="rgba(255,255,255,.45)" />
          <rect x="175" y="116" width="54" height="8" rx="4" fill="rgba(255,255,255,.45)" />
          <rect x="70" y="196" width="160" height="34" rx="17" fill="rgba(255,255,255,.95)" />
          <text x="150" y="219" textAnchor="middle" fontSize="15" fontWeight="700" fill="#5233ec" fontFamily="Inter, sans-serif">$ 12,480.00</text>
        </svg>
      </div>
      <img className="logo" src="logo.svg" alt="Kova" />
      <h1>{t('welcomeTitle')}</h1>
      <p>{t('welcomeText')}</p>
      {found && (
        <div className="found glass">
          <b><PiClockCounterClockwiseBold /> {t('backupFound')}</b>
          <span>{t('backupFoundD')}</span>
          <span className="when">{found.mtime ? new Date(found.mtime).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : found.name}{found.size ? ` · ${(found.size / 1048576).toFixed(1)} MB` : ''}</span>
          <button className="btn light" disabled={busy} onClick={restoreFound}><PiCloudArrowDownBold /> {t('restoreNow')}</button>
        </div>
      )}
      <button className={'btn ' + (found ? 'ghost' : 'light')} onClick={() => setState((s) => ({ ...s, settings: { ...s.settings, onboarded: true } }))}>
        <PiSparkleBold /> {t('startFresh')}
      </button>
      <button className="btn ghost" onClick={() => restoreFromFile(t, false)}>
        <PiCloudArrowDownBold /> {t('restoreBackupWelcome')}
      </button>
      <button className="btn ghost" onClick={() => runMmImport(t)}>
        <PiDownloadSimpleBold /> {t('importOther')}
      </button>
      <div style={{ fontSize: 12.5, opacity: 0.7, marginTop: 12, textAlign: 'center' }}>{found === null ? t('noBackupFound') : t('restoreHint')}</div>
    </div>
  );
}

function CrashSheet({ text }: { text: string }) {
  const { t } = useT();
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch { /* ignore */ }
  };
  return (
    <Sheet title={t('crashTitle')} footer={<button className="btn primary" onClick={copy}>{t('copy')}</button>}>
      <div className="sheet-b">
        <div className="small muted" style={{ marginBottom: 10 }}>{t('crashText')}</div>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, background: 'var(--sunk)', padding: 12, borderRadius: 14, maxHeight: '50vh', overflow: 'auto' }}>{text.slice(-6000)}</pre>
      </div>
    </Sheet>
  );
}
