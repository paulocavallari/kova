import { idbGet, idbSet } from './store';
import type { AiConfig } from './types';

const AI_KEY_ID = 'ai-key-v1';

export type AiUrlError = 'empty' | 'invalid' | 'https' | 'credentials' | 'query';

export type NormalizedUrl = { ok: true; url: string } | { ok: false; error: AiUrlError };

export interface AiKeyStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, val: unknown): Promise<void>;
}

const defaultStorage: AiKeyStorage = {
  get: (key) => idbGet<string>(key),
  set: (key, val) => idbSet(key, val),
};

let storage: AiKeyStorage = defaultStorage;

/** Replaces the backing storage in tests; pass null to restore IndexedDB. */
export function setAiKeyStorage(custom: AiKeyStorage | null) {
  storage = custom ?? defaultStorage;
}

/** Validates an HTTPS base URL without credentials, query or hash, stripping endpoint suffixes. */
export function normalizeBaseUrl(raw: string): NormalizedUrl {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'empty' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'https' };
  if (url.username || url.password) return { ok: false, error: 'credentials' };
  if (url.search || url.hash || trimmed.includes('?') || trimmed.includes('#')) {
    return { ok: false, error: 'query' };
  }
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/(?:chat\/completions|models)$/i, '').replace(/\/+$/, '');
  return { ok: true, url: `${url.origin}${path}` };
}

export async function getAiKey(): Promise<string | undefined> {
  const raw = await storage.get(AI_KEY_ID);
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

export async function setAiKey(key: string): Promise<void> {
  await storage.set(AI_KEY_ID, key.trim());
}

export async function clearAiKey(): Promise<void> {
  await storage.set(AI_KEY_ID, '');
}

/** Masks an API key from any error or status text. */
export function redactKey(text: string, key?: string): string {
  const value = String(text ?? '');
  const trimmed = key?.trim();
  if (!trimmed) return value;
  return value.split(trimmed).join('***');
}

export function isConfigured(cfg?: Partial<AiConfig> | null, key?: string | boolean): boolean {
  if (!cfg || !cfg.baseUrl || !cfg.model?.trim()) return false;
  if (!normalizeBaseUrl(cfg.baseUrl).ok) return false;
  if (typeof key === 'string') return key.trim().length > 0;
  if (typeof key === 'boolean') return key;
  return true;
}
