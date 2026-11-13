import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { normalizeBaseUrl, redactKey } from './ai-config';
import type { AiConfig, AiEffort } from './types';

export type AiErrorCode =
  | 'network'
  | 'auth'
  | 'model'
  | 'rate'
  | 'server'
  | 'redirect'
  | 'format'
  | 'length'
  | 'context';

export class AiError extends Error {
  readonly code: AiErrorCode;
  requests?: number;
  droppedEffort?: boolean;
  droppedTools?: boolean;
  constructor(code: AiErrorCode, message: string, key?: string) {
    super(redactKey(message, key).slice(0, 200));
    this.name = 'AiError';
    this.code = code;
  }
}

export interface AiModel {
  id: string;
  efforts?: string[];
  mandatory?: boolean;
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface RawToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: RawToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finish: string;
  requests: number;
  droppedEffort?: boolean;
  droppedTools?: boolean;
}

export interface ClientOpts {
  fetchImpl?: typeof fetch;
}

interface HttpResult {
  status: number;
  ok: boolean;
  body: unknown;
  rawText: string;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function requireValidRequest(baseUrl: string, key: string): { base: string; trimmedKey: string } {
  const norm = normalizeBaseUrl(baseUrl);
  if (!norm.ok) throw new AiError('format', `Invalid base URL (${norm.error})`, key);
  const trimmedKey = key.trim();
  if (!trimmedKey) throw new AiError('auth', 'Missing API key', key);
  return { base: norm.url, trimmedKey };
}

async function requestJson(
  url: string,
  method: 'GET' | 'POST',
  key: string,
  payload?: Record<string, unknown>,
  opts: ClientOpts = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (payload !== undefined) headers['Content-Type'] = 'application/json';

  if (!opts.fetchImpl && Capacitor.getPlatform() === 'android') {
    let res: { status?: number; data?: unknown };
    try {
      res = await CapacitorHttp.request({
        url,
        method,
        headers,
        ...(payload !== undefined ? { data: payload } : {}),
        readTimeout: 180000,
        connectTimeout: 20000,
        disableRedirects: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Network error';
      throw new AiError('network', msg, key);
    }
    const status = typeof res.status === 'number' ? res.status : 0;
    if (status >= 300 && status < 400) throw new AiError('redirect', `HTTP ${status} redirect`, key);
    let body: unknown = res.data;
    let rawText = typeof res.data === 'string' ? res.data : '';
    if (typeof res.data === 'string') {
      try {
        body = JSON.parse(res.data);
      } catch {
        body = undefined;
      }
    }
    return { status, ok: status >= 200 && status < 300, body, rawText };
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      redirect: 'error',
    });
  } catch (e) {
    const cause = e instanceof Error && (e as any).cause instanceof Error ? (e as any).cause.message : '';
    const msg = e instanceof Error ? `${e.message} ${cause}` : 'Network error';
    const code: AiErrorCode = /redirect/i.test(msg) ? 'redirect' : 'network';
    throw new AiError(code, msg.trim(), key);
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new AiError('redirect', `HTTP ${res.status} redirect`, key);
  }
  const rawText = await res.text().catch(() => '');
  let body: unknown;
  try {
    body = rawText ? JSON.parse(rawText) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, ok: res.status >= 200 && res.status < 300, body, rawText };
}

function errorDetails(res: HttpResult): { message: string; code: string; param: string } {
  const root = asObj(res.body);
  const err = asObj(root?.error) ?? root;
  const message = typeof err?.message === 'string' ? err.message : res.rawText || `HTTP ${res.status}`;
  const code = typeof err?.code === 'string' ? err.code : '';
  const param = typeof err?.param === 'string' ? err.param : '';
  return { message, code, param };
}

function mapHttpError(res: HttpResult, key: string): AiError {
  const { message, code } = errorDetails(res);
  const combined = `${code} ${message}`;
  if (res.status === 401 || res.status === 403) return new AiError('auth', message, key);
  if (res.status === 429) return new AiError('rate', message, key);
  if (res.status >= 500) return new AiError('server', message, key);
  if (
    res.status === 413 ||
    /context_length_exceeded|context[_ ]length|maximum context|too many tokens|token limit|reduce the length/i.test(combined)
  ) {
    return new AiError('context', message, key);
  }
  if (
    res.status === 404 ||
    /model_not_found|model.*not found|unknown model|invalid model/i.test(combined)
  ) {
    return new AiError('model', message, key);
  }
  return new AiError('format', message, key);
}

/** Fetches and normalizes available models from GET /models. */
export async function listModels(
  cfg: Pick<AiConfig, 'baseUrl'>,
  key: string,
  opts: ClientOpts = {},
): Promise<AiModel[]> {
  const { base, trimmedKey } = requireValidRequest(cfg.baseUrl, key);
  const res = await requestJson(`${base}/models`, 'GET', trimmedKey, undefined, opts);
  if (!res.ok) throw mapHttpError(res, trimmedKey);

  const root = asObj(res.body);
  const items = Array.isArray(res.body) ? res.body : Array.isArray(root?.data) ? root.data : null;
  if (!items) throw new AiError('format', 'Invalid models response', trimmedKey);

  const byId = new Map<string, AiModel>();
  for (const raw of items) {
    const item = asObj(raw);
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id || byId.has(id)) continue;
    const reasoning = asObj(item?.reasoning);
    const efforts = Array.isArray(reasoning?.supported_efforts)
      ? reasoning.supported_efforts.filter((e): e is string => typeof e === 'string' && !!e)
      : undefined;
    const mandatory = typeof reasoning?.mandatory === 'boolean' ? reasoning.mandatory : undefined;
    const model: AiModel = { id };
    if (efforts) model.efforts = efforts;
    if (mandatory !== undefined) model.mandatory = mandatory;
    byId.set(id, model);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function parseChatBody(body: unknown, key: string): { content: string; toolCalls: ToolCall[]; finish: string } {
  const root = asObj(body);
  const choices = Array.isArray(root?.choices) ? root.choices : null;
  const first = choices ? asObj(choices[0]) : null;
  const msg = first ? asObj(first.message) : null;
  if (!first || !msg) throw new AiError('format', 'Invalid chat completion response', key);

  const finish = typeof first.finish_reason === 'string' ? first.finish_reason : 'stop';
  const content = typeof msg.content === 'string' ? msg.content : '';
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const toolCalls: ToolCall[] = [];
  for (const item of rawCalls) {
    const tc = asObj(item);
    const fn = tc ? asObj(tc.function) : null;
    if (
      typeof tc?.id !== 'string' ||
      typeof fn?.name !== 'string' ||
      typeof fn?.arguments !== 'string'
    ) {
      throw new AiError('format', 'Invalid tool call in response', key);
    }
    toolCalls.push({ id: tc.id, name: fn.name, arguments: fn.arguments });
  }
  if (finish === 'length' && !content && toolCalls.length === 0) {
    throw new AiError('length', 'Output stopped at length limit with empty content', key);
  }
  return { content, toolCalls, finish };
}

/** Sends a non-streaming Chat Completions request with single retries for effort/tools rejection. */
export async function chat(
  cfg: AiConfig,
  key: string,
  req: { messages: ChatMessage[]; tools?: ToolDef[]; effort?: AiEffort },
  opts: ClientOpts = {},
): Promise<ChatResult> {
  const { base, trimmedKey } = requireValidRequest(cfg.baseUrl, key);
  let effort = req.effort ?? cfg.effort;
  let tools = req.tools?.length ? req.tools : undefined;
  let droppedEffort = false;
  let droppedTools = false;
  let requests = 0;

  for (;;) {
    const payload: Record<string, unknown> = {
      model: cfg.model,
      messages: req.messages,
    };
    if (effort && effort !== 'auto') payload.reasoning_effort = effort;
    if (tools) payload.tools = tools;

    requests++;
    const res = await requestJson(`${base}/chat/completions`, 'POST', trimmedKey, payload, opts);
    if (res.ok) {
      const parsed = parseChatBody(res.body, trimmedKey);
      return {
        ...parsed,
        requests,
        ...(droppedEffort ? { droppedEffort: true } : {}),
        ...(droppedTools ? { droppedTools: true } : {}),
      };
    }

    const details = errorDetails(res);
    const combined = `${details.code} ${details.message}`;
    const canDropParam = res.status === 400 || res.status === 422;
    if (
      canDropParam &&
      effort !== 'auto' &&
      !droppedEffort &&
      (details.param === 'reasoning_effort' || /reasoning_effort/i.test(combined))
    ) {
      effort = 'auto';
      droppedEffort = true;
      continue;
    }
    if (
      canDropParam &&
      tools &&
      !droppedTools &&
      (details.param === 'tools' ||
        details.param === 'tool_choice' ||
        /\btools\b|tool_choice|function.?calling|tool.?use/i.test(combined))
    ) {
      tools = undefined;
      droppedTools = true;
      continue;
    }
    const err = mapHttpError(res, trimmedKey);
    err.requests = requests;
    err.droppedEffort = droppedEffort;
    err.droppedTools = droppedTools;
    throw err;
  }
}
