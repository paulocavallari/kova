import { useSyncExternalStore, useMemo } from 'react';
import type { State } from './types';
import { initialState, detectLang } from './defaults';
import { balances, totalBalance, ensureRecurring, today } from './calc';
import { writeAutoBackup, writePublicBackup } from '../native';
import { syncReminders } from './reminders';

const DB_NAME = 'kova';
const STORE = 'kv';
const KEY = 'state-v1';

export function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 2);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
      if (!r.result.objectStoreNames.contains('files')) r.result.createObjectStore('files');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    tx.onsuccess = () => res(tx.result as T);
    tx.onerror = () => rej(tx.error);
  });
}
export async function idbSet(key: string, val: unknown) {
  const db = await idb();
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

let state: State = initialState(detectLang());
let loaded = false;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function emit() {
  listeners.forEach((l) => l());
}

export async function loadState() {
  try {
    const s = await idbGet<State>(KEY);
    if (s && s.version === 1) state = migrate(s);
    else {
      // fallback for environments without IndexedDB persistence
      const ls = safeLocal();
      if (ls) state = migrate(JSON.parse(ls));
    }
  } catch {
    const ls = safeLocal();
    if (ls) state = migrate(JSON.parse(ls));
  }
  loaded = true;
  emit();
  await maintenance();
}

/** Daily housekeeping: create next occurrences of recurring items and write the automatic backup. */
export async function maintenance() {
  syncReminders(state);
  import('./widget').then((w) => w.syncWidget(state)).catch(() => {});
  import('./notif').then((n) => n.pushBrain(state)).catch(() => {});
  const next = ensureRecurring(state);
  if (next !== state) {
    state = next;
    emit();
    persist();
  }
  import('./pluggy')
    .then((p) => p.autoSyncPluggyVia(() => state, setState))
    .catch(() => { /* isolated per connection */ });
  // safety net: a month without any backup yet (e.g. first start after the update)
  if (state.settings.onboarded && state.settings.autoBackup && (state.settings.lastBackup ?? '').slice(0, 7) !== today().slice(0, 7)) {
    await backupNow();
  }
}

// ---------- automatic backup ----------
// Every change schedules a backup a few seconds later (and right away when the app goes to the
// background). There is one file per month, overwritten each time: no pile of copies.
let backupTimer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;
let running: Promise<boolean> | null = null;

function scheduleBackup() {
  if (!state.settings.onboarded || !state.settings.autoBackup) return;
  dirty = true;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => { flushBackup(); }, 5000);
}

export async function flushBackup() {
  clearTimeout(backupTimer);
  if (!dirty) return true;
  return backupNow();
}

const hasData = (s: State) => s.txs.length > 0 || s.transfers.length > 0;

export async function backupNow(): Promise<boolean> {
  if (running) await running.catch(() => {});
  dirty = false;
  running = (async () => {
    try {
      if (!hasData(state)) return true; // never overwrite a good backup with an empty app
      const { buildBackup } = await import('./backup');
      const json = await buildBackup(state);
      const prev = state.settings.lastBackupTxs ?? 0;
      // a sudden big drop in transactions keeps the previous copy aside, just in case
      const shrink = prev > 20 && state.txs.length < prev * 0.5;
      const ok = await writeAutoBackup(json, today(), shrink);
      await writePublicBackup(json, today());
      if (ok) {
        state = { ...state, settings: { ...state.settings, lastBackup: new Date().toISOString(), lastBackupTxs: state.txs.length } };
        emit();
        saveSoon();
      }
      return ok;
    } catch {
      dirty = true;
      return false;
    }
  })();
  const r = await running;
  running = null;
  return r;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!loaded) return;
    if (document.visibilityState === 'visible') maintenance();
    else flushBackup();
  });
}

function safeLocal() {
  try { return localStorage.getItem('kova-' + KEY); } catch { return null; }
}

function migrate(s: State): State {
  const d = initialState(detectLang());
  return { ...d, ...s, settings: { ...d.settings, ...s.settings } };
}

function persist() {
  syncReminders(state);
  import('./widget').then((w) => w.syncWidget(state)).catch(() => {});
  import('./notif').then((n) => n.pushBrain(state)).catch(() => {});
  scheduleBackup();
  saveSoon();
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    idbSet(KEY, state).catch(() => {
      try { localStorage.setItem('kova-' + KEY, JSON.stringify(state)); } catch { /* ignore */ }
    });
  }, 250);
}

export function getState() {
  return state;
}

export function setState(fn: (s: State) => State) {
  state = ensureRecurring(fn(state));
  emit();
  persist();
}

export function replaceState(s: State) {
  state = migrate(s);
  emit();
  persist();
}

export function isLoaded() {
  return loaded;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore(): State {
  return useSyncExternalStore(subscribe, () => state);
}

export function useBalances() {
  const s = useStore();
  const day = today();
  return useMemo(() => {
    const b = balances(s);
    return { bal: b, total: totalBalance(s, b) };
  }, [s.accounts, s.txs, s.transfers, s.settings.rates, s.settings.baseCurrency, day]);
}
