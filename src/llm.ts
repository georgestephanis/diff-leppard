import { Logger, nullLogger } from './types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type JsonMode = 'json_object' | 'json_schema' | 'none';

export interface LlmConfig {
  provider: 'openai' | 'ollama';
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature: number;
  maxOutputTokens: number;
  jsonMode: JsonMode;
  stream: boolean;
  timeoutMs: number;
  ollamaNumCtx: number;
  extraHeaders?: Record<string, string>;
  /** Extra fields merged into every chat request body (e.g. chat_template_kwargs, top_k, think). */
  extraBody?: Record<string, unknown>;
}

export interface ChatOptions {
  signal?: AbortSignal;
  /** JSON schema used when jsonMode is json_schema. */
  schema?: object;
  /** Called as output arrives with the number of characters received so far. */
  onProgress?: (chars: number) => void;
  /** Override maxOutputTokens for this request. */
  maxTokens?: number;
}

export interface ChatResult {
  content: string;
  /** True when the server reports it stopped because of the token limit. */
  truncated: boolean;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

/** Error text that means "this server doesn't support the structured-output parameters we sent". */
const STRUCTURED_OUTPUT_ERROR = /response_format|json_schema|json_object|guided[_ ]|grammar|structured output|\bformat\b.*(not supported|unsupported|invalid)/i;

export class LlmClient {
  /** Set when the server rejected structured output once; we stop asking for it. */
  private jsonModeOverride?: JsonMode;

  constructor(
    private readonly cfg: LlmConfig,
    private readonly log: Logger = nullLogger,
  ) {}

  get model(): string {
    return this.cfg.model;
  }

  private base(): string {
    let b = this.cfg.baseUrl.trim().replace(/\/+$/, '');
    if (this.cfg.provider === 'ollama') b = b.replace(/\/v1$/, '');
    return b;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...(this.cfg.extraHeaders ?? {}) };
    if (this.cfg.apiKey) h.Authorization = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  private async request(url: string, init: RequestInit, signal?: AbortSignal, timeoutMs = this.cfg.timeoutMs): Promise<Response> {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers: this.headers(), signal: AbortSignal.any(signals) });
    } catch (e) {
      throw this.wrapNetworkError(e, url, signal, timeoutMs);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let msg = `${res.status} ${res.statusText} from ${url}`;
      const detail = extractErrorMessage(body);
      if (detail) msg += `: ${detail}`;
      if (res.status === 404 && this.cfg.provider === 'openai' && !/\/v\d+$/.test(this.base())) {
        msg += ' (OpenAI-compatible servers usually need the base URL to end in /v1)';
      }
      if (res.status === 401 || res.status === 403) msg += ' (check the API key: "Diff Leppard: Set LLM API Key")';
      throw new LlmError(msg, res.status, body);
    }
    return res;
  }

  private wrapNetworkError(e: unknown, url: string, signal: AbortSignal | undefined, timeoutMs: number): Error {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    if (signal?.aborted) return new LlmError('Cancelled');
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return new LlmError(`Request to ${url} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    const cause = err.cause?.code ?? err.cause?.message ?? err.message;
    return new LlmError(`Could not reach ${url} (${cause}). Is the server running and is diffLeppard.baseUrl correct?`);
  }

  /**
   * The context window (in tokens) the server reports for the configured model, if it reports one.
   * vLLM: max_model_len; apfel and others: context_window / context_length / max_context_length.
   * For the native Ollama provider it's the num_ctx we send.
   */
  async contextWindow(signal?: AbortSignal): Promise<number | undefined> {
    if (this.cfg.provider === 'ollama') return this.cfg.ollamaNumCtx;
    const res = await this.request(`${this.base()}/models`, { method: 'GET' }, signal, 15000);
    const json = (await res.json()) as { data?: Record<string, unknown>[] };
    const entry = (json.data ?? []).find((m) => m.id === this.cfg.model) ?? (json.data?.length === 1 ? json.data[0] : undefined);
    for (const k of ['max_model_len', 'context_window', 'context_length', 'max_context_length']) {
      const v = entry?.[k];
      if (typeof v === 'number' && v > 0) return v;
    }
    return undefined;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    if (this.cfg.provider === 'ollama') {
      const res = await this.request(`${this.base()}/api/tags`, { method: 'GET' }, signal, 15000);
      const json = (await res.json()) as { models?: { name: string }[] };
      return (json.models ?? []).map((m) => m.name);
    }
    const res = await this.request(`${this.base()}/models`, { method: 'GET' }, signal, 15000);
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => m.id);
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const mode = this.jsonModeOverride ?? this.cfg.jsonMode;
    try {
      return await this.chatOnce(messages, mode, opts);
    } catch (e) {
      if (
        e instanceof LlmError &&
        mode !== 'none' &&
        (e.status === 400 || e.status === 422) &&
        STRUCTURED_OUTPUT_ERROR.test(e.body ?? e.message)
      ) {
        this.log.warn(`Server rejected structured output (${mode}); retrying without it. ${e.message}`);
        this.jsonModeOverride = 'none';
        return await this.chatOnce(messages, 'none', opts);
      }
      throw e;
    }
  }

  private async chatOnce(messages: ChatMessage[], mode: JsonMode, opts: ChatOptions): Promise<ChatResult> {
    return this.cfg.provider === 'ollama' ? this.chatOllama(messages, mode, opts) : this.chatOpenAI(messages, mode, opts);
  }

  private async chatOpenAI(messages: ChatMessage[], mode: JsonMode, opts: ChatOptions): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: this.cfg.temperature,
      max_tokens: opts.maxTokens ?? this.cfg.maxOutputTokens,
      stream: this.cfg.stream,
      ...(this.cfg.extraBody ?? {}),
    };
    if (mode === 'json_object') body.response_format = { type: 'json_object' };
    else if (mode === 'json_schema' && opts.schema) {
      body.response_format = { type: 'json_schema', json_schema: { name: 'code_review', schema: opts.schema } };
    }
    const url = `${this.base()}/chat/completions`;
    this.log.debug(`POST ${url} model=${this.cfg.model} json=${mode} stream=${this.cfg.stream}`);
    const res = await this.request(url, { method: 'POST', body: JSON.stringify(body) }, opts.signal);

    const ctype = res.headers.get('content-type') ?? '';
    if (!this.cfg.stream || !ctype.includes('text/event-stream')) {
      const json = (await res.json()) as OpenAIResponse;
      const choice = json.choices?.[0];
      const content = choice?.message?.content ?? '';
      opts.onProgress?.(content.length);
      return { content, truncated: choice?.finish_reason === 'length' };
    }

    let content = '';
    let reasoning = 0;
    let truncated = false;
    await readLines(res, (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let evt: OpenAIResponse;
      try {
        evt = JSON.parse(data);
      } catch {
        return;
      }
      if (evt.error) throw new LlmError(`Server error during streaming: ${extractErrorMessage(JSON.stringify(evt))}`);
      const choice = evt.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      if (delta.content) content += delta.content;
      const r = delta.reasoning_content ?? delta.reasoning;
      if (r) reasoning += r.length;
      if (choice.finish_reason === 'length') truncated = true;
      opts.onProgress?.(content.length + reasoning);
    });
    return { content, truncated };
  }

  private async chatOllama(messages: ChatMessage[], mode: JsonMode, opts: ChatOptions): Promise<ChatResult> {
    const extra = { ...(this.cfg.extraBody ?? {}) } as Record<string, unknown>;
    const extraOptions = (extra.options as Record<string, unknown>) ?? {};
    delete extra.options;
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      stream: this.cfg.stream,
      ...extra,
      options: {
        temperature: this.cfg.temperature,
        num_ctx: this.cfg.ollamaNumCtx,
        num_predict: opts.maxTokens ?? this.cfg.maxOutputTokens,
        ...extraOptions,
      },
    };
    if (mode === 'json_object') body.format = 'json';
    else if (mode === 'json_schema' && opts.schema) body.format = opts.schema;
    const url = `${this.base()}/api/chat`;
    this.log.debug(`POST ${url} model=${this.cfg.model} json=${mode} stream=${this.cfg.stream} num_ctx=${this.cfg.ollamaNumCtx}`);
    const res = await this.request(url, { method: 'POST', body: JSON.stringify(body) }, opts.signal);

    if (!this.cfg.stream) {
      const json = (await res.json()) as OllamaChunk;
      const content = json.message?.content ?? '';
      opts.onProgress?.(content.length);
      return { content, truncated: json.done_reason === 'length' };
    }
    let content = '';
    let thinking = 0;
    let truncated = false;
    await readLines(res, (line) => {
      if (!line.trim()) return;
      let evt: OllamaChunk;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      if (evt.error) throw new LlmError(`Ollama error: ${evt.error}`);
      if (evt.message?.content) content += evt.message.content;
      if (evt.message?.thinking) thinking += evt.message.thinking.length;
      if (evt.done && evt.done_reason === 'length') truncated = true;
      opts.onProgress?.(content.length + thinking);
    });
    return { content, truncated };
  }
}

interface OpenAIResponse {
  error?: unknown;
  choices?: {
    finish_reason?: string | null;
    message?: { content?: string | null };
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
  }[];
}

interface OllamaChunk {
  error?: string;
  done?: boolean;
  done_reason?: string;
  message?: { content?: string; thinking?: string };
}

async function readLines(res: Response, onLine: (line: string) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finished = false;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        const name = (e as Error).name;
        if (name === 'TimeoutError') throw new LlmError('Model request timed out while streaming (raise requestTimeoutSeconds)');
        if (name === 'AbortError') throw new LlmError('Cancelled');
        throw new LlmError(`Stream from model server failed: ${(e as Error).message}`);
      }
      const { done, value } = chunk;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        onLine(line);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) onLine(buf.replace(/\r$/, ''));
    finished = true;
  } finally {
    // On an error event (or any throw) release the connection instead of leaving it open until the timeout.
    if (!finished) await reader.cancel().catch(() => undefined);
  }
}

/** A tiny request to check the server answers chat completions. Shared by the extension and the CLI. */
export async function healthCheck(client: LlmClient, signal?: AbortSignal): Promise<{ content: string; ms: number }> {
  const t0 = Date.now();
  const r = await client.chat(
    [
      { role: 'system', content: 'You are a health check. Respond with JSON only.' },
      { role: 'user', content: 'Respond with exactly {"ok": true}' },
    ],
    { signal, maxTokens: 256, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
  );
  return { content: r.content, ms: Date.now() - t0 };
}

function extractErrorMessage(body: string): string {
  if (!body) return '';
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message ?? j?.error ?? j?.message ?? j?.detail;
    if (typeof m === 'string') return m.slice(0, 500);
    if (m) return JSON.stringify(m).slice(0, 500);
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500);
}

/** Chunk size used when maxChunkChars is "auto" (0) and the server doesn't report a context window. */
export const FALLBACK_CHUNK_CHARS = 24000;
/** Upper bound for auto-sized chunks: review quality drops on huge prompts even when they fit. */
export const MAX_AUTO_CHUNK_CHARS = 100000;
const PROMPT_OVERHEAD_TOKENS = 1500;
/** Conservative: code is often denser than the usual ~3.5–4 chars/token. */
const CHARS_PER_TOKEN = 3;

/**
 * Resolve maxChunkChars. A positive value is used as-is; 0 means "auto": size requests to the model's
 * context window (minus the output budget and prompt overhead), falling back to FALLBACK_CHUNK_CHARS.
 */
export async function resolveChunkChars(
  client: LlmClient,
  configured: number,
  maxOutputTokens: number,
  log: Logger,
  signal?: AbortSignal,
): Promise<number> {
  if (configured > 0) return configured;
  let ctx: number | undefined;
  try {
    ctx = await client.contextWindow(signal);
  } catch (e) {
    log.debug(`Could not read the model's context window: ${(e as Error).message}`);
  }
  if (!ctx) {
    log.info(`Server doesn't report a context window; using ${FALLBACK_CHUNK_CHARS} diff characters per request (set maxChunkChars to override).`);
    return FALLBACK_CHUNK_CHARS;
  }
  const available = ctx - maxOutputTokens - PROMPT_OVERHEAD_TOKENS;
  if (available < 1000) {
    log.warn(`maxOutputTokens (${maxOutputTokens}) leaves almost no room in the model's ${ctx}-token context; lower it or set maxChunkChars.`);
    return 2000;
  }
  const chars = Math.min(MAX_AUTO_CHUNK_CHARS, Math.max(2000, available * CHARS_PER_TOKEN));
  log.info(`Model context is ${ctx} tokens → up to ${chars} diff characters per request.`);
  return chars;
}
