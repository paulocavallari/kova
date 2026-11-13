import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/lib/defaults';
import { getState, replaceState } from '../src/lib/store';
import { buildBackup } from '../src/lib/backup';
import {
  normalizeBaseUrl,
  getAiKey,
  setAiKey,
  clearAiKey,
  setAiKeyStorage,
  redactKey,
  isConfigured,
} from '../src/lib/ai-config';

const FAKE_KEY = 'TESTKEY-AAAA-0000';

test('normalizeBaseUrl accepts https and strips trailing slash and known endpoints', () => {
  assert.deepEqual(normalizeBaseUrl('https://api.openai.com/v1/'), { ok: true, url: 'https://api.openai.com/v1' });
  assert.deepEqual(normalizeBaseUrl(' https://api.openai.com/v1/chat/completions '), { ok: true, url: 'https://api.openai.com/v1' });
  assert.deepEqual(normalizeBaseUrl('https://openrouter.ai/api/v1/models/'), { ok: true, url: 'https://openrouter.ai/api/v1' });
  assert.deepEqual(normalizeBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai'), { ok: true, url: 'https://generativelanguage.googleapis.com/v1beta/openai' });
});

test('normalizeBaseUrl rejects http, invalid URL, credentials, query and hash', () => {
  assert.equal(normalizeBaseUrl('').ok, false);
  assert.equal(normalizeBaseUrl('not-a-url').ok, false);
  const httpRes = normalizeBaseUrl('http://localhost:11434/v1');
  assert.equal(httpRes.ok, false);
  if (!httpRes.ok) assert.equal(httpRes.error, 'https');
  const credRes = normalizeBaseUrl('https://user:pass@api.openai.com/v1');
  assert.equal(credRes.ok, false);
  if (!credRes.ok) assert.equal(credRes.error, 'credentials');
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1?key=abc').ok, false);
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1#frag').ok, false);
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1?').ok, false);
});

test('setAiKey, getAiKey and clearAiKey store outside State and clear leaves absent (N2)', async () => {
  const mem = new Map<string, unknown>();
  setAiKeyStorage({
    get: async (k) => mem.get(k) as any,
    set: async (k, v) => { mem.set(k, v); },
  });
  try {
    assert.equal(await getAiKey(), undefined);
    await setAiKey(FAKE_KEY);
    assert.equal(await getAiKey(), FAKE_KEY);
    assert.equal(mem.has('ai-key-v1'), true);
    await setAiKey('   ');
    assert.equal(await getAiKey(), undefined);
    await clearAiKey();
    assert.equal(await getAiKey(), undefined);
  } finally {
    setAiKeyStorage(null);
  }
});

test('setAiKey trims surrounding whitespace', async () => {
  const mem = new Map<string, unknown>();
  setAiKeyStorage({
    get: async (k) => mem.get(k) as any,
    set: async (k, v) => { mem.set(k, v); },
  });
  try {
    await setAiKey(`  ${FAKE_KEY}  `);
    assert.equal(await getAiKey(), FAKE_KEY);
  } finally {
    setAiKeyStorage(null);
  }
});

test('setAiKey never leaks into State, backup JSON or localStorage', async () => {
  const mem = new Map<string, unknown>();
  setAiKeyStorage({
    get: async (k) => mem.get(k) as any,
    set: async (k, v) => { mem.set(k, v); },
  });
  const lsData = new Map<string, string>();
  const origLs = (globalThis as any).localStorage;
  (globalThis as any).localStorage = {
    getItem: (k: string) => lsData.get(k) ?? null,
    setItem: (k: string, v: string) => lsData.set(k, v),
    removeItem: (k: string) => lsData.delete(k),
  };
  try {
    const base = initialState('pt');
    replaceState({ ...base, settings: { ...base.settings, ai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', effort: 'auto' } } });
    const ref = getState();
    await setAiKey(FAKE_KEY);
    assert.equal(getState(), ref);
    const stateJson = JSON.stringify(getState());
    assert.equal(stateJson.includes(FAKE_KEY), false);
    const backup = await buildBackup(getState());
    assert.equal(backup.includes(FAKE_KEY), false);
    assert.equal(JSON.stringify([...lsData.entries()]).includes(FAKE_KEY), false);
  } finally {
    setAiKeyStorage(null);
    (globalThis as any).localStorage = origLs;
  }
});

test('redactKey masks all occurrences of the key', () => {
  assert.equal(redactKey(`Bearer ${FAKE_KEY} failed for ${FAKE_KEY}`, FAKE_KEY), 'Bearer *** failed for ***');
  assert.equal(redactKey('no secret here', FAKE_KEY), 'no secret here');
  assert.equal(redactKey('safe text', ''), 'safe text');
});

test('isConfigured validates baseUrl, model and optional key', () => {
  assert.equal(isConfigured(undefined), false);
  assert.equal(isConfigured({ baseUrl: 'http://bad', model: 'm', effort: 'auto' }), false);
  assert.equal(isConfigured({ baseUrl: 'https://api.openai.com/v1', model: '', effort: 'auto' }), false);
  assert.equal(isConfigured({ baseUrl: 'https://api.openai.com/v1', model: 'm', effort: 'auto' }), true);
  assert.equal(isConfigured({ baseUrl: 'https://api.openai.com/v1', model: 'm', effort: 'auto' }, ''), false);
  assert.equal(isConfigured({ baseUrl: 'https://api.openai.com/v1', model: 'm', effort: 'auto' }, false), false);
  assert.equal(isConfigured({ baseUrl: 'https://api.openai.com/v1', model: 'm', effort: 'auto' }, FAKE_KEY), true);
});
