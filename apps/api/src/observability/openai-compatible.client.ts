import { performance } from 'node:perf_hooks';
import type { TraceContext } from './trace-context';
import {
  AiAdapterError,
  beginObservation,
  httpError,
  providerEndpoint,
  readProviderJson,
} from './ai-observation';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_SSE_BYTES = 8 * 1024 * 1024;
const MAX_SSE_FRAME_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter']);

export interface OpenAiCompatibleInput {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  signal?: AbortSignal;
}

export interface OpenAiCompatibleUsage {
  input: number;
  output: number;
  total: number;
}

export interface OpenAiCompatibleCompletion {
  model: string;
  content: string;
  usage?: OpenAiCompatibleUsage;
  finishReason: string | null;
}

export interface OpenAiCompatibleStreamChunk {
  content?: string;
  usage?: OpenAiCompatibleUsage;
  finishReason?: string | null;
}

interface Deadline {
  signal: AbortSignal;
  failure(error: unknown): AiAdapterError;
  throwIfAborted(): void;
  abort(): void;
  cleanup(): void;
}

interface StreamFrame {
  done: boolean;
  payload?: unknown;
}

interface StreamUpdate {
  content?: string;
  usage?: OpenAiCompatibleUsage;
  finishReason?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeModelName(value: unknown): value is string {
  return typeof value === 'string' && MODEL_NAME.test(value);
}

function finishReasonAttribute(reason: string | null): string {
  if (reason === null) return 'unknown';
  return FINISH_REASONS.has(reason) ? reason : 'other';
}

function parseUsage(value: unknown): OpenAiCompatibleUsage | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new AiAdapterError('invalid_response');

  const input = value.prompt_tokens ?? value.input_tokens;
  const output = value.completion_tokens ?? value.output_tokens;
  if (!Number.isSafeInteger(input) || (input as number) < 0
    || !Number.isSafeInteger(output) || (output as number) < 0) {
    throw new AiAdapterError('invalid_response');
  }
  const total = (input as number) + (output as number);
  if (!Number.isSafeInteger(total)) throw new AiAdapterError('invalid_response');
  if (value.total_tokens !== undefined
    && (!Number.isSafeInteger(value.total_tokens)
      || (value.total_tokens as number) < 0
      || value.total_tokens !== total)) {
    throw new AiAdapterError('invalid_response');
  }
  return { input: input as number, output: output as number, total };
}

function makeDeadline(timeoutMs: number, externalSignal?: AbortSignal): Deadline {
  const controller = new AbortController();
  let abortReason: 'timeout' | 'cancelled' | undefined;
  const abortFromCaller = () => {
    if (abortReason !== undefined) return;
    abortReason = 'cancelled';
    controller.abort();
  };

  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });

  const timer = setTimeout(() => {
    if (abortReason !== undefined) return;
    abortReason = 'timeout';
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    failure(error) {
      if (abortReason === 'timeout') return new AiAdapterError('timeout');
      if (abortReason === 'cancelled') return new AiAdapterError('cancelled');
      if (error instanceof AiAdapterError) return error;
      return new AiAdapterError('network_error');
    },
    throwIfAborted() {
      if (controller.signal.aborted) throw this.failure(new Error());
    },
    abort() { controller.abort(); },
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

function requestBody(input: OpenAiCompatibleInput, streaming: boolean): string {
  if (!input || !safeModelName(input.model) || !Array.isArray(input.messages) || input.messages.length === 0) {
    throw new AiAdapterError('invalid_request');
  }
  const messages = input.messages.map((message) => {
    if (!isRecord(message)
      || !['system', 'user', 'assistant'].includes(String(message.role))
      || typeof message.content !== 'string') {
      throw new AiAdapterError('invalid_request');
    }
    return { role: message.role, content: message.content };
  });

  let body: string;
  try {
    body = JSON.stringify({
      model: input.model,
      messages,
      ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
    });
  } catch {
    throw new AiAdapterError('invalid_request');
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) throw new AiAdapterError('invalid_request');
  return body;
}

function setBaseAttributes(
  observation: ReturnType<typeof beginObservation>,
  model: unknown,
  streaming: boolean,
): void {
  if (safeModelName(model)) {
    observation.set('model', model);
    observation.set('requested_model', model);
    observation.set('llm.model', model);
  }
  observation.set('llm.streaming', streaming);
  observation.set('llm.usage_available', false);
}

function setReturnedModel(observation: ReturnType<typeof beginObservation>, model: unknown): void {
  if (safeModelName(model)) {
    observation.set('model', model);
    observation.set('llm.response_model', model);
  }
}

function setUsage(
  observation: ReturnType<typeof beginObservation>,
  usage: OpenAiCompatibleUsage | undefined,
): void {
  if (!usage) return;
  observation.set('llm.usage_available', true);
  observation.setUsage(usage.input, usage.output);
}

function parseCompletion(value: unknown): OpenAiCompatibleCompletion {
  if (!isRecord(value)) throw new AiAdapterError('invalid_response');
  if (value.error !== undefined && value.error !== null) throw new AiAdapterError('provider_error');
  if (!Array.isArray(value.choices) || value.choices.length === 0) {
    throw new AiAdapterError('invalid_response');
  }

  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) throw new AiAdapterError('invalid_response');
  const rawContent = choice.message.content;
  if (rawContent !== null && typeof rawContent !== 'string') throw new AiAdapterError('invalid_response');
  const rawFinishReason = choice.finish_reason;
  if (rawFinishReason !== null && typeof rawFinishReason !== 'string') {
    throw new AiAdapterError('invalid_response');
  }
  const usage = parseUsage(value.usage);
  return {
    model: safeModelName(value.model) ? value.model : '',
    content: rawContent ?? '',
    ...(usage ? { usage } : {}),
    finishReason: rawFinishReason,
  };
}

function parseStreamPayload(value: unknown): StreamUpdate {
  if (!isRecord(value)) throw new AiAdapterError('invalid_response');
  if (value.error !== undefined && value.error !== null) throw new AiAdapterError('provider_error');

  const usage = parseUsage(value.usage);
  if (value.choices === undefined || !Array.isArray(value.choices)) {
    throw new AiAdapterError('invalid_response');
  }
  if (value.choices.length === 0) return usage ? { usage } : {};

  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.delta)) throw new AiAdapterError('invalid_response');
  const rawContent = choice.delta.content;
  if (rawContent !== undefined && rawContent !== null && typeof rawContent !== 'string') {
    throw new AiAdapterError('invalid_response');
  }
  const rawFinishReason = choice.finish_reason;
  if (rawFinishReason !== undefined && rawFinishReason !== null && typeof rawFinishReason !== 'string') {
    throw new AiAdapterError('invalid_response');
  }

  return {
    ...(typeof rawContent === 'string' && rawContent.length > 0 ? { content: rawContent } : {}),
    ...(usage ? { usage } : {}),
    ...(rawFinishReason !== undefined ? { finishReason: rawFinishReason as string | null } : {}),
  };
}

function parseFramePayload(data: string): unknown {
  try { return JSON.parse(data); }
  catch { throw new AiAdapterError('invalid_response'); }
}

async function* readSseFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<StreamFrame, void, unknown> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let frameBytes = 0;
  let totalBytes = 0;
  let dataLines: string[] = [];
  let hasData = false;

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > MAX_SSE_BYTES) throw new AiAdapterError('invalid_response');

    try { pending += decoder.decode(result.value, { stream: true }); }
    catch { throw new AiAdapterError('invalid_response'); }

    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const rawLine = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      frameBytes += Buffer.byteLength(rawLine, 'utf8') + 1;
      if (frameBytes > MAX_SSE_FRAME_BYTES) throw new AiAdapterError('invalid_response');
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

      if (line === '') {
        frameBytes = 0;
        if (hasData) {
          const data = dataLines.join('\n');
          dataLines = [];
          hasData = false;
          if (data === '[DONE]') {
            yield { done: true };
            return;
          }
          yield { done: false, payload: parseFramePayload(data) };
        }
      } else if (!line.startsWith(':')) {
        const separator = line.indexOf(':');
        const field = separator < 0 ? line : line.slice(0, separator);
        let fieldValue = separator < 0 ? '' : line.slice(separator + 1);
        if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
        if (field === 'data') {
          dataLines.push(fieldValue);
          hasData = true;
        }
      }
      newline = pending.indexOf('\n');
    }

    if (frameBytes + Buffer.byteLength(pending, 'utf8') > MAX_SSE_FRAME_BYTES) {
      throw new AiAdapterError('invalid_response');
    }
  }

  try { pending += decoder.decode(); }
  catch { throw new AiAdapterError('invalid_response'); }
  if (frameBytes + Buffer.byteLength(pending, 'utf8') > MAX_SSE_FRAME_BYTES) {
    throw new AiAdapterError('invalid_response');
  }
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* the connection may already be closed */ }
}

async function providerHttpError(response: Response): Promise<AiAdapterError> {
  const fallback = httpError(response.status);
  try {
    const payload = await readProviderJson(response, MAX_REQUEST_BYTES);
    if (isRecord(payload) && isRecord(payload.error)
      && payload.error.code === 'content_policy_violation') {
      return new AiAdapterError('content_filter', response.status);
    }
  } catch { /* a provider error body never replaces the safe HTTP classification */ }
  return fallback;
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try { await reader.cancel(); } catch { /* the request may already be aborted */ }
  try { reader.releaseLock(); } catch { /* cancellation may have released it */ }
}

export class OpenAiCompatibleClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly context: TraceContext,
    private readonly options: { baseUrl: string; apiKey: string; timeoutMs?: number },
  ) {
    if (typeof options.apiKey !== 'string' || options.apiKey.length === 0 || /[\r\n]/.test(options.apiKey)) {
      throw new AiAdapterError('invalid_request');
    }
    this.endpoint = new URL('chat/completions', providerEndpoint(options.baseUrl)).toString();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new AiAdapterError('invalid_request');
    }
  }

  async complete(input: OpenAiCompatibleInput): Promise<OpenAiCompatibleCompletion> {
    const observation = beginObservation(this.context, 'llm.generate');
    const startedAt = performance.now();
    setBaseAttributes(observation, input?.model, false);
    const deadline = makeDeadline(this.timeoutMs, input?.signal);
    let failure: unknown;

    try {
      const body = requestBody(input, false);
      const response = await observation.run(() => fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        redirect: 'manual',
        signal: deadline.signal,
      }));
      deadline.throwIfAborted();
      if (!response.ok) {
        const error = await providerHttpError(response);
        deadline.throwIfAborted();
        throw error;
      }

      const raw = await observation.run(() => readProviderJson(response, MAX_REQUEST_BYTES));
      deadline.throwIfAborted();
      const completion = parseCompletion(raw);
      const responseModel = isRecord(raw) ? raw.model : undefined;
      setReturnedModel(observation, responseModel);
      setUsage(observation, completion.usage);
      observation.set('llm.finish_reason', finishReasonAttribute(completion.finishReason));
      if (completion.finishReason === 'content_filter') failure = new AiAdapterError('content_filter');

      return {
        model: safeModelName(responseModel) ? responseModel : input.model,
        content: completion.content,
        ...(completion.usage ? { usage: completion.usage } : {}),
        finishReason: completion.finishReason,
      };
    } catch (error) {
      failure = deadline.failure(error);
      throw failure;
    } finally {
      if (failure) deadline.abort();
      observation.set('llm.total_latency_ms', Math.max(0, performance.now() - startedAt));
      observation.finish(failure);
      deadline.cleanup();
    }
  }

  async *stream(input: OpenAiCompatibleInput): AsyncGenerator<OpenAiCompatibleStreamChunk, void, unknown> {
    const observation = beginObservation(this.context, 'llm.generate');
    const startedAt = performance.now();
    setBaseAttributes(observation, input?.model, true);
    const deadline = makeDeadline(this.timeoutMs, input?.signal);
    let failure: unknown;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let receivedDone = false;
    let hasFinishReason = false;
    let firstContentAt: number | undefined;
    let contentFilterFailure: AiAdapterError | undefined;

    try {
      const body = requestBody(input, true);
      const response = await observation.run(() => fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body,
        redirect: 'manual',
        signal: deadline.signal,
      }));
      deadline.throwIfAborted();
      if (!response.ok) {
        const error = await providerHttpError(response);
        deadline.throwIfAborted();
        throw error;
      }
      if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') || !response.body) {
        await cancelBody(response);
        throw new AiAdapterError('invalid_response');
      }

      reader = response.body.getReader();
      for await (const frame of readSseFrames(reader)) {
        deadline.throwIfAborted();
        if (frame.done) {
          receivedDone = true;
          break;
        }

        const payload = frame.payload;
        if (isRecord(payload) && payload.model !== undefined) setReturnedModel(observation, payload.model);
        const update = parseStreamPayload(payload);
        setUsage(observation, update.usage);
        if (update.finishReason !== undefined) {
          hasFinishReason = true;
          observation.set('llm.finish_reason', finishReasonAttribute(update.finishReason));
          if (update.finishReason === 'content_filter') contentFilterFailure = new AiAdapterError('content_filter');
        }

        if (update.content) {
          // TTFT measures the first non-empty content delta, never a role or usage frame.
          if (firstContentAt === undefined) {
            firstContentAt = performance.now();
            observation.set('llm.ttft_ms', Math.max(0, firstContentAt - startedAt));
          }
        }

        if (update.content || update.usage || update.finishReason !== undefined) {
          yield {
            ...(update.content ? { content: update.content } : {}),
            ...(update.usage ? { usage: update.usage } : {}),
            ...(update.finishReason !== undefined ? { finishReason: update.finishReason } : {}),
          };
          // A suspended consumer does not pause the overall request deadline.
          deadline.throwIfAborted();
        }
      }

      deadline.throwIfAborted();
      if (!receivedDone) throw new AiAdapterError('invalid_response');
      if (!hasFinishReason) observation.set('llm.finish_reason', 'unknown');
    } catch (error) {
      failure = deadline.failure(error);
      throw failure;
    } finally {
      if (!receivedDone && !failure) failure = new AiAdapterError('cancelled');
      if (!receivedDone || failure) deadline.abort();
      if (reader) await cancelReader(reader);
      observation.set('llm.total_latency_ms', Math.max(0, performance.now() - startedAt));
      observation.finish(failure ?? contentFilterFailure);
      deadline.cleanup();
    }
  }
}
