import { useEffect, useState, type ReactNode } from 'react';
import type { AiEffort } from '../lib/types';
import { setState, useStore } from '../lib/store';
import { useT } from '../i18n';
import { Seg, Sheet } from './ui';
import { closeOverlay, toast } from '../lib/nav';
import { clearAiKey, getAiKey, normalizeBaseUrl, setAiKey } from '../lib/ai-config';
import { listModels, type AiModel } from '../lib/ai-client';
import { aiErrorLabel } from '../lib/ai-chat';
export { aiErrorLabel };

const DEFAULT_EFFORTS: AiEffort[] = ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function effortChoices(meta: AiModel | undefined): AiEffort[] {
  if (!meta?.efforts?.length) return DEFAULT_EFFORTS;
  const list = meta.efforts.filter((e) => !(meta.mandatory && e === 'none'));
  return ['auto', ...new Set(list)] as AiEffort[];
}

export function AiSettingsSheet({ onDone }: { onDone?: () => void }) {
  const s = useStore();
  const { t } = useT();
  const saved = s.settings.ai;
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? '');
  const [keyInput, setKeyInput] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [model, setModel] = useState(saved?.model ?? '');
  const [effort, setEffort] = useState<AiEffort>(saved?.effort ?? 'auto');
  const [models, setModels] = useState<AiModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    getAiKey().then((k) => setHasKey(Boolean(k))).catch(() => setHasKey(false));
  }, []);

  const selectedMeta = models.find((m) => m.id === model);
  const efforts = effortChoices(selectedMeta);
  const activeEffort = efforts.includes(effort) ? effort : 'auto';

  const field = (label: string, node: ReactNode, hint?: string) => (
    <label className="field">
      <span>{label}</span>
      {node}
      {hint && <div className="small muted" style={{ marginTop: 4 }}>{hint}</div>}
    </label>
  );

  const fetchList = async () => {
    const norm = normalizeBaseUrl(baseUrl);
    if (!norm.ok) {
      setErr(t('aiErrUrl'));
      return;
    }
    const activeKey = keyInput.trim() || (await getAiKey().catch(() => undefined)) || '';
    if (!activeKey) {
      setErr(t('aiErrKeyMissing'));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const list = await listModels({ baseUrl: norm.url }, activeKey);
      setModels(list);
      if (list.length && !list.some((m) => m.id === model)) setModel(list[0].id);
    } catch (e) {
      setModels([]);
      setErr(aiErrorLabel(t, e));
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    try {
      await clearAiKey();
      setHasKey(false);
      setKeyInput('');
      toast(t('aiKeyRemoved'));
    } catch {
      toast(t('aiKeyKept'));
    }
  };

  const save = async () => {
    const norm = normalizeBaseUrl(baseUrl);
    if (!norm.ok) {
      setErr(t('aiErrUrl'));
      return;
    }
    const cleanModel = model.trim();
    if (!cleanModel) {
      setErr(t('aiErrModelMissing'));
      return;
    }
    if (keyInput.trim()) {
      try {
        await setAiKey(keyInput.trim());
      } catch {
        setErr(t('aiKeySaveFailed'));
        return;
      }
      setHasKey(true);
    }
    setState((x) => ({
      ...x,
      settings: { ...x.settings, ai: { baseUrl: norm.url, model: cleanModel, effort: activeEffort } },
    }));
    toast(t('savedOk'));
    (onDone ?? closeOverlay)();
  };

  return (
    <Sheet
      title={t('aiTitle')}
      footer={<button className="btn primary" onClick={save}>{t('save')}</button>}
    >
      <div className="sheet-b">
        {field(
          t('aiBaseUrl'),
          <input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />,
          t('aiBaseUrlHint'),
        )}
        {field(
          t('aiKey'),
          <input
            type="password"
            autoComplete="off"
            value={keyInput}
            placeholder={hasKey ? '••••••' : ''}
            onChange={(e) => setKeyInput(e.target.value)}
          />,
        )}
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <button className="btn soft" style={{ flex: 1 }} disabled={busy} onClick={fetchList}>
            {busy ? t('aiFetching') : t('aiFetchModels')}
          </button>
          {hasKey && (
            <button className="btn danger" disabled={busy} onClick={removeKey}>
              {t('aiRemoveKey')}
            </button>
          )}
        </div>
        {err && <div className="small" style={{ color: 'var(--exp)', marginBottom: 10 }}>{err}</div>}
        {field(
          t('aiModel'),
          models.length > 0 ? (
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.id}</option>
              ))}
            </select>
          ) : (
            <input type="text" value={model} onChange={(e) => setModel(e.target.value)} />
          ),
        )}
        <div className="field">
          <span>{t('aiEffort')}</span>
          <Seg
            value={activeEffort}
            onChange={(v) => setEffort(v)}
            options={efforts.map((v) => ({ v, label: v === 'auto' ? t('auto') : v }))}
            small
          />
        </div>
        <div className="small muted" style={{ padding: '4px 4px 8px' }}>{t('aiSendNotice')}</div>
      </div>
    </Sheet>
  );
}
