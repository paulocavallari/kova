import test from 'node:test';
import assert from 'node:assert/strict';
import { AiError, chat, listModels } from '../src/lib/ai-client';
import type { AiConfig } from '../src/lib/types';

const FAKE_KEY = 'TESTKEY-AAAA-0000';
const cfg: AiConfig = { baseUrl: 'https://api.example.test/v1', model: 'm-alpha', effort: 'medium' };

// Ensure global fetch is never reached if fetchImpl is omitted unexpectedly.
(globalThis as any).fetch = async () => {
  throw new Error('rede proibida');
};

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('listModels parses OpenAI data wrapper, deduplicates and sorts', async () => {
  let authHeader = '';
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.example.test/v1/models');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    authHeader = (init?.headers as Record<string, string>)?.Authorization ?? '';
    return jsonRes(200, {
      object: 'list',
      data: [{ id: 'm-z' }, { id: 'm-a' }, { id: 'm-a' }, { id: 123 }, {}],
    });
  }) as typeof fetch;

  const list = await listModels(cfg, FAKE_KEY, { fetchImpl });
  assert.equal(authHeader, `Bearer ${FAKE_KEY}`);
  assert.deepEqual(list.map((m) => m.id), ['m-a', 'm-z']);
});

test('listModels parses root array and OpenRouter reasoning metadata', async () => {
  const fetchImpl = (async () =>
    jsonRes(200, [
      { id: 'or-1', reasoning: { supported_efforts: ['low', 'high'], mandatory: true } },
      { id: 'or-2', reasoning: { supported_efforts: ['none', 'medium', 42], mandatory: false } },
    ])) as typeof fetch;

  const list = await listModels(cfg, FAKE_KEY, { fetchImpl });
  assert.deepEqual(list, [
    { id: 'or-1', efforts: ['low', 'high'], mandatory: true },
    { id: 'or-2', efforts: ['none', 'medium'], mandatory: false },
  ]);
});

test('chat sends messages, omits auto effort and tool_choice, counts 1 request', async () => {
  let sentBody: any;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.example.test/v1/chat/completions');
    sentBody = JSON.parse(String(init?.body));
    return jsonRes(200, {
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Resposta ok' } }],
    });
  }) as typeof fetch;

  const res = await chat(
    { ...cfg, effort: 'auto' },
    FAKE_KEY,
    { messages: [{ role: 'user', content: 'Oi' }] },
    { fetchImpl },
  );
  assert.equal(res.content, 'Resposta ok');
  assert.deepEqual(res.toolCalls, []);
  assert.equal(res.finish, 'stop');
  assert.equal(res.requests, 1);
  assert.equal('reasoning_effort' in sentBody, false);
  assert.equal('tool_choice' in sentBody, false);
  assert.equal('max_tokens' in sentBody, false);
  assert.equal('temperature' in sentBody, false);
});

test('chat parses tool_calls', async () => {
  const fetchImpl = (async () =>
    jsonRes(200, {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'tc-1', type: 'function', function: { name: 'simulate_purchase', arguments: '{"amount":1000}' } },
            ],
          },
        },
      ],
    })) as typeof fetch;

  const res = await chat(cfg, FAKE_KEY, {
    messages: [{ role: 'user', content: 'Simular' }],
    tools: [{ type: 'function', function: { name: 'simulate_purchase', description: 'sim', parameters: {} } }],
  }, { fetchImpl });
  assert.equal(res.finish, 'tool_calls');
  assert.equal(res.requests, 1);
  assert.deepEqual(res.toolCalls, [{ id: 'tc-1', name: 'simulate_purchase', arguments: '{"amount":1000}' }]);
});

test('chat maps 401, 404, 429, 500 and redacts API key from error messages', async () => {
  const cases: [number, string, string][] = [
    [401, `bad key ${FAKE_KEY}`, 'auth'],
    [404, 'model missing', 'model'],
    [429, 'rate limit', 'rate'],
    [500, 'internal error', 'server'],
  ];
  for (const [status, msg, code] of cases) {
    const fetchImpl = (async () => jsonRes(status, { error: { message: msg } })) as typeof fetch;
    await assert.rejects(
      () => chat(cfg, FAKE_KEY, { messages: [{ role: 'user', content: 'Oi' }] }, { fetchImpl }),
      (e: unknown) => {
        assert.ok(e instanceof AiError);
        assert.equal(e.code, code);
        assert.equal(e.message.includes(FAKE_KEY), false);
        assert.ok(e.message.length <= 200);
        return true;
      },
    );
  }
});

test('chat maps network failure and redirect (3xx and fetch redirect error)', async () => {
  const netFail = (async () => {
    throw new Error(`connect ECONNREFUSED ${FAKE_KEY}`);
  }) as typeof fetch;
  await assert.rejects(
    () => chat(cfg, FAKE_KEY, { messages: [{ role: 'user', content: 'Oi' }] }, { fetchImpl: netFail }),
    (e: unknown) => e instanceof AiError && e.code === 'network' && !e.message.includes(FAKE_KEY),
  );

  const redirStatus = (async () => new Response('', { status: 302, headers: { location: 'https://evil.test' } })) as typeof fetch;
  await assert.rejects(
    () => chat(cfg, FAKE_KEY, { messages: [{ role: 'user', content: 'Oi' }] }, { fetchImpl: redirStatus }),
    (e: unknown) => e instanceof AiError && e.code === 'redirect',
  );

  const redirThrow = (async () => {
    throw new TypeError('redirect mode is set to error');
  }) as typeof fetch;
  await assert.rejects(
    () => chat(cfg, FAKE_KEY, { messages: [{ role: 'user', content: 'Oi' }] }, { fetchImpl: redirThrow }),
    (e: unknown) => e instanceof AiError && e.code === 'redirect',
  );
});

test('chat maps invalid JSON and finish_reason length with empty content', async () => {
  const badJson = (async () => new Response('<html>oops</html>', { status: 200 })) as typeof fetch;
  await assert.rejects(
    () => chat(cfg, FAKE_KEY, { messages: [{ role: 'user', content: 'Oi' }] }, { fetchImpl: badJson }),
    (e: unknown) => e instanceof AiError && e.code === 'format',
  );

  const lenEmpty = (async () =>
    jsonRes(200, { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }] })) as typeof fetch;
  await assert.rejects(
    () => chat(cfg, FAKE_KEY, { messages: [{ role: 'user', content: 'Oi' }] }, { fetchImpl: lenEmpty }),
    (e: unknown) => e instanceof AiError && e.code === 'length',
  );
});

test('chat maps context length error to code context', async () => {
  const fetchImpl = (async () =>
    jsonRes(400, { error: { code: 'context_length_exceeded', message: 'maximum context length exceeded' } })) as typeof fetch;
  await assert.rejects(
    () => chat(cfg, FAKE_KEY, { messages: [{ role: 'user', content: 'Oi' }] }, { fetchImpl }),
    (e: unknown) => e instanceof AiError && e.code === 'context',
  );
});

test('chat retries once without reasoning_effort when rejected (D7)', async () => {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body));
    bodies.push(b);
    if (bodies.length === 1) {
      return jsonRes(400, { error: { param: 'reasoning_effort', message: 'Unsupported parameter: reasoning_effort' } });
    }
    return jsonRes(200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] });
  }) as typeof fetch;

  const res = await chat(cfg, FAKE_KEY, { messages: [{ role: 'user', content: 'Oi' }], effort: 'high' }, { fetchImpl });
  assert.equal(res.requests, 2);
  assert.equal(res.droppedEffort, true);
  assert.equal(bodies[0].reasoning_effort, 'high');
  assert.equal('reasoning_effort' in bodies[1], false);
});

test('chat retries once without tools when rejected (D8)', async () => {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body));
    bodies.push(b);
    if (bodies.length === 1) {
      return jsonRes(400, { error: { param: 'tools', message: 'tools are not supported by this model' } });
    }
    return jsonRes(200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'sem tool' } }] });
  }) as typeof fetch;

  const res = await chat(
    { ...cfg, effort: 'auto' },
    FAKE_KEY,
    {
      messages: [{ role: 'user', content: 'Oi' }],
      tools: [{ type: 'function', function: { name: 'simulate_purchase', description: 'sim', parameters: {} } }],
    },
    { fetchImpl },
  );
  assert.equal(res.requests, 2);
  assert.equal(res.droppedTools, true);
  assert.ok(Array.isArray(bodies[0].tools));
  assert.equal('tools' in bodies[1], false);
});

test('chat truncates long error messages to 200 characters', async () => {
  const longMsg = 'X'.repeat(350);
  const fetchImpl = (async () => jsonRes(500, { error: { message: longMsg } })) as typeof fetch;
  await assert.rejects(
    () => chat(cfg, FAKE_KEY, { messages: [{ role: 'user', content: 'Oi' }] }, { fetchImpl }),
    (e: unknown) => e instanceof AiError && e.message.length <= 200,
  );
});

test('listModels rejects malformed payloads and invalid baseUrl', async () => {
  const badUrl = { baseUrl: 'http://insecure.test/v1' };
  await assert.rejects(
    () => listModels(badUrl, FAKE_KEY, { fetchImpl: (async () => jsonRes(200, [])) as typeof fetch }),
    (e: unknown) => e instanceof AiError && e.code === 'format',
  );
  await assert.rejects(
    () => listModels(cfg, FAKE_KEY, { fetchImpl: (async () => jsonRes(200, { nope: true })) as typeof fetch }),
    (e: unknown) => e instanceof AiError && e.code === 'format',
  );
});

test('chat does not leak key when server echoes key in non-JSON body', async () => {
  const fetchImpl = (async () => new Response(`Unauthorized ${FAKE_KEY}`, { status: 401 })) as typeof fetch;
  await assert.rejects(
    () => chat(cfg, FAKE_KEY, { messages: [{ role: 'user', content: 'Oi' }] }, { fetchImpl }),
    (e: unknown) => e instanceof AiError && e.code === 'auth' && !e.message.includes(FAKE_KEY),
  );
});
