import type { PluggyConn, State } from './types';
import { getState, replaceState } from './store';
import { getFile, putFile, blobToBase64, base64ToBlob } from './files';
/** Full backup: state + attachment files (base64). Secrets are never exported. */
export async function buildBackup(state: State = getState()) {
  const files: Record<string, { type: string; b64: string }> = {};
  for (const tx of state.txs) {
    for (const a of tx.attachments ?? []) {
      const b = await getFile(a.id);
      if (b) files[a.id] = { type: a.type, b64: await blobToBase64(b) };
    }
  }
  const safe = state.pluggy?.length
    ? {
        ...state,
        pluggy: state.pluggy.map((c) => {
          const copy: Partial<PluggyConn> = { ...c };
          delete copy.clientSecret;
          return copy as PluggyConn;
        }),
      }
    : state;
  return JSON.stringify({ app: 'kova', version: 1, exported: new Date().toISOString(), state: safe, files });
}
export async function restoreBackup(text: string) {
  if (!text || !text.trim()) throw new Error('EMPTY');
  let j: any;
  try { j = JSON.parse(text); } catch { throw new Error('BROKEN'); }
  const state: State = j.state ?? j;
  if (!state || !Array.isArray(state.accounts) || !Array.isArray(state.txs)) throw new Error('NOT_KOVA');
  for (const [id, f] of Object.entries((j.files ?? {}) as Record<string, { type: string; b64: string }>)) {
    await putFile(id, base64ToBlob(f.b64, f.type));
  }
  const local = getState();
  const pluggy = state.pluggy?.map((c) => {
    const saved = (local.pluggy ?? []).find((x) => x.id === c.id);
    const clientSecret = c.clientSecret || saved?.clientSecret || '';
    return { ...c, clientSecret, enabled: clientSecret ? c.enabled : false };
  });
  const next: State = pluggy ? { ...state, pluggy } : state;
  const accounts = next.accounts.map((a) => {
    if (!a.pluggy?.bills) return a;
    const pluggy = { ...a.pluggy };
    delete pluggy.bills;
    return { ...a, pluggy };
  });
  replaceState({ ...next, accounts, settings: { ...next.settings, onboarded: true } });
  return { txs: state.txs.length, accounts: state.accounts.length, exported: j.exported as string | undefined };
}
