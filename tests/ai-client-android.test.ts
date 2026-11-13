import test from 'node:test';
import assert from 'node:assert/strict';
import type { AiConfig } from '../src/lib/types';

interface BridgeCall {
  plugin: string;
  method: string;
  options: any;
}

const calls: BridgeCall[] = [];
let fetchCalls = 0;
let handler: (options: any) => any = () => ({ status: 200, data: {} });

(globalThis as any).CapacitorCustomPlatform = { name: 'android' };
(globalThis as any).Capacitor = {
  PluginHeaders: [{ name: 'CapacitorHttp', methods: [{ name: 'request', rtype: 'promise' }] }],
  nativePromise: async (plugin: string, method: string, options: any) => {
    calls.push({ plugin, method, options });
    return handler(options);
  },
};
(globalThis as any).fetch = async () => {
  fetchCalls++;
  throw new Error('rede proibida');
};

const { Capacitor } = await import('@capacitor/core');
const { AiError, chat, listModels } = await import('../src/lib/ai-client');

const FAKE_KEY = 'TESTKEY-AAAA-0000';
const cfg: AiConfig = { baseUrl: 'https://api.example.test/v1', model: 'm-android', effort: 'low' };

test('android platform uses CapacitorHttp with timeouts, disableRedirects and Bearer header', async () => {
  assert.equal(Capacitor.getPlatform(), 'android');
  calls.length = 0;
  handler = (opt) => {
    if (opt.url.endsWith('/models')) {
      return { status: 200, data: { data: [{ id: 'm-android' }] } };
    }
    return {
      status: 200,
      data: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok android' } }] }),
    };
  };

  const models = await listModels(cfg, FAKE_KEY);
  assert.deepEqual(models, [{ id: 'm-android' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].plugin, 'CapacitorHttp');
  assert.equal(calls[0].method, 'request');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.url, 'https://api.example.test/v1/models');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(calls[0].options.disableRedirects, true);
  assert.equal(calls[0].options.connectTimeout, 20000);
  assert.equal(calls[0].options.readTimeout, 180000);

  const res = await chat(cfg, FAKE_KEY, { messages: [{ role: 'user', content: 'Oi' }] });
  assert.equal(res.content, 'ok android');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.url, 'https://api.example.test/v1/chat/completions');
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].options.disableRedirects, true);
  assert.equal(fetchCalls, 0);
});

test('android bridge maps 3xx redirect and redacts key on bridge errors', async () => {
  calls.length = 0;
  handler = () => ({ status: 302, data: {} });
  await assert.rejects(
    () => listModels(cfg, FAKE_KEY),
    (e: unknown) => e instanceof AiError && e.code === 'redirect',
  );

  handler = () => {
    throw new Error(`bridge failed ${FAKE_KEY}`);
  };
  await assert.rejects(
    () => chat(cfg, FAKE_KEY, { messages: [{ role: 'user', content: 'Oi' }] }),
    (e: unknown) => e instanceof AiError && e.code === 'network' && !e.message.includes(FAKE_KEY),
  );
  assert.equal(fetchCalls, 0);
});

test('injected fetchImpl takes precedence over CapacitorHttp on android', async () => {
  calls.length = 0;
  let injected = 0;
  const fetchImpl = (async () => {
    injected++;
    return new Response(JSON.stringify({ data: [{ id: 'm-inj' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const models = await listModels(cfg, FAKE_KEY, { fetchImpl });
  assert.deepEqual(models, [{ id: 'm-inj' }]);
  assert.equal(injected, 1);
  assert.equal(calls.length, 0);
});
