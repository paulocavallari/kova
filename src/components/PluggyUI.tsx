import { useState, type ReactNode } from 'react';
import { PiLinkBold, PiArrowsClockwiseBold, PiTrashBold, PiPlusBold, PiPlugsConnectedBold } from 'react-icons/pi';
import type { PluggyConn, State } from '../lib/types';
import { getState, setState, useStore } from '../lib/store';
import { useT } from '../i18n';
import { Sheet, Switch } from './ui';
import { openOverlay, toast } from '../lib/nav';
import { syncPluggyVia, testPluggyConn } from '../lib/pluggy';

export const hasPluggyConn = (s: State) => (s.pluggy ?? []).some((c) => c.enabled);

export const newPluggyConn = (): PluggyConn => ({
  id: crypto.randomUUID(),
  name: '',
  clientId: '',
  clientSecret: '',
  itemIds: [],
  baseUrl: 'https://api.pluggy.ai',
  enabled: true,
  auto: true,
});

export const savePluggyConn = (c: PluggyConn) =>
  setState((s) => ({
    ...s,
    pluggy: [...(s.pluggy ?? []).filter((x) => x.id !== c.id), c],
  }));

export const removePluggyConn = (id: string) =>
  setState((s) => ({
    ...s,
    pluggy: (s.pluggy ?? []).filter((x) => x.id !== id),
  }));

export const patchPluggyConn = (id: string, patch: Partial<PluggyConn>) =>
  setState((s) => ({
    ...s,
    pluggy: (s.pluggy ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x)),
  }));

export async function runPluggySync(id?: string) {
  const result = await syncPluggyVia(getState, setState, id);
  return result.ok;
}

/** Safe failure category for the sheet; raw details stay only in lastError. */
export function pluggyErrorLabel(t: (key: any) => string, message?: string): string {
  const m = message ?? '';
  if (/invalid base url/i.test(m)) return t('pluggyErrConfig');
  if (/incomplete|invalid account|invalid transaction/i.test(m)) return t('pluggyErrData');
  if (/HTTP 401|HTTP 403|apiKey|auth/i.test(m)) return t('pluggyErrAuth');
  if (/HTTP 404/i.test(m)) return t('pluggyErrNotFound');
  if (/network/i.test(m)) return t('pluggyErrNetwork');
  if (/HTTP 5\d\d|pagination|JSON|cursor|envelope/i.test(m)) return t('pluggyErrData');
  return t('pluggyErrGeneric');
}

function ConnForm({ initial, onDone }: { initial: PluggyConn; onDone: () => void }) {
  const { t } = useT();
  const [c, setC] = useState(initial);
  const [secret, setSecret] = useState('');
  const [idsText, setIdsText] = useState(initial.itemIds.join('\n'));
  const set = (patch: Partial<PluggyConn>) => setC({ ...c, ...patch });
  const field = (label: string, node: ReactNode) => (
    <label className="field">
      <span>{label}</span>
      {node}
    </label>
  );
  const save = () => {
    const clientSecret = secret || c.clientSecret;
    if (!c.name || !c.clientId || !clientSecret) {
      toast(t('pluggyInvalid'));
      return;
    }
    savePluggyConn({
      ...c,
      clientSecret,
      itemIds: idsText.split(/[\s,]+/).filter(Boolean),
    });
    onDone();
  };
  return (
    <Sheet title={t('pluggyTitle')} footer={<button className="btn primary" onClick={save}>{t('save')}</button>}>
      <div className="sheet-b">
        {field(t('name'), <input value={c.name} onChange={(e) => set({ name: e.target.value })} />)}
        {field(t('pluggyClientId'), <input value={c.clientId} onChange={(e) => set({ clientId: e.target.value })} />)}
        {field(t('pluggyClientSecret'), <input type="password" value={secret} placeholder={c.clientSecret ? '••••••' : ''} onChange={(e) => setSecret(e.target.value)} />)}
        {field(t('pluggyItemIds'), <textarea value={idsText} onChange={(e) => setIdsText(e.target.value)} />)}
        {field(t('pluggyBaseUrl'), <input value={c.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />)}
        <div className="setting">
          <div className="grow">
            <div className="t">{t('pluggyEnabled')}</div>
          </div>
          <Switch on={c.enabled} label={t('pluggyEnabled')} onChange={(v) => set({ enabled: v })} />
        </div>
        <div className="setting">
          <div className="grow">
            <div className="t">{t('pluggyAuto')}</div>
          </div>
          <Switch on={c.auto} label={t('pluggyAuto')} onChange={(v) => set({ auto: v })} />
        </div>
      </div>
    </Sheet>
  );
}

export function PluggySettingsSheet() {
  const s = useStore();
  const { t } = useT();
  const [edit, setEdit] = useState<PluggyConn | null>(null);
  const [busy, setBusy] = useState('');
  if (edit) return <ConnForm initial={edit} onDone={() => setEdit(null)} />;
  const conns = s.pluggy ?? [];
  const run = async (id?: string) => {
    setBusy(id ?? '*');
    try {
      const ok = await runPluggySync(id);
      toast(ok ? t('pluggySynced') : t('pluggyFailed'));
    } finally {
      setBusy('');
    }
  };
  const test = async (c: PluggyConn) => {
    setBusy(c.id);
    try {
      const r = await testPluggyConn(c);
      toast(r.ok ? t('pluggyTestOk') : `${t('pluggyTestFail')}: ${pluggyErrorLabel(t, r.error)}`);
    } finally {
      setBusy('');
    }
  };
  return (
    <Sheet title={t('pluggyTitle')} full>
      <div className="sheet-b">
        <div className="paper flush">
          {conns.length === 0 && <div className="small muted" style={{ padding: 16 }}>{t('pluggyEmpty')}</div>}
          {conns.map((c) => {
            const linked = s.accounts.filter((a) => a.pluggy?.apiId === c.id);
            return (
              <div key={c.id}>
                <div className="setting">
                  <div className="set-ico"><PiLinkBold /></div>
                  <button className="grow" style={{ textAlign: 'left' }} onClick={() => setEdit(c)}>
                    <div className="t">{c.name || t('pluggyTitle')}</div>
                    <div className="s">
                      {c.lastStatus === 'error'
                        ? `${t('pluggyFailed')} · ${pluggyErrorLabel(t, c.lastError)}`
                        : c.lastSyncAt
                          ? new Date(c.lastSyncAt).toLocaleString()
                          : t('pluggyNever')}
                    </div>
                  </button>
                  <button className="icon-btn" disabled={!!busy} onClick={() => test(c)} aria-label={t('pluggyTest')} title={t('pluggyTest')}>
                    <PiPlugsConnectedBold />
                  </button>
                  <button className="icon-btn" disabled={!!busy} onClick={() => run(c.id)} aria-label={t('pluggySync')} title={t('pluggySync')}>
                    <PiArrowsClockwiseBold />
                  </button>
                  <button className="icon-btn" disabled={!!busy} onClick={() => removePluggyConn(c.id)} aria-label={t('delete')} title={t('delete')}>
                    <PiTrashBold />
                  </button>
                </div>
                <div className="setting">
                  <div className="grow small muted">{t('pluggyEnabled')}</div>
                  <Switch on={c.enabled} label={t('pluggyEnabled')} onChange={(v) => patchPluggyConn(c.id, { enabled: v })} />
                </div>
                <div className="setting">
                  <div className="grow small muted">{t('pluggyAuto')}</div>
                  <Switch on={c.auto} label={t('pluggyAuto')} onChange={(v) => patchPluggyConn(c.id, { auto: v })} />
                </div>
                <div className="small muted" style={{ padding: '0 16px 12px' }}>
                  {t('pluggyAccounts')}: {linked.length ? linked.map((a) => `${a.name} (${a.pluggy?.accountId})`).join(' · ') : t('pluggyNoAccounts')}
                </div>
              </div>
            );
          })}
        </div>
        <button className="btn ghost" style={{ width: '100%', marginTop: 12 }} onClick={() => setEdit(newPluggyConn())}>
          <PiPlusBold /> {t('pluggyAdd')}
        </button>
        <button className="btn primary" style={{ width: '100%', marginTop: 8 }} disabled={!!busy || !conns.length} onClick={() => run()}>
          {busy === '*' ? t('pluggySyncing') : t('pluggySyncAll')}
        </button>
      </div>
    </Sheet>
  );
}

export function PluggyHomeShortcut() {
  const s = useStore();
  const { t } = useT();
  if (!hasPluggyConn(s)) return null;
  return (
    <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => openOverlay(() => <PluggySettingsSheet />)}>
      <PiLinkBold /> {t('pluggyQuick')}
    </button>
  );
}
