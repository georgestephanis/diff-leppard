"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_AUTO_CHUNK_CHARS = exports.FALLBACK_CHUNK_CHARS = exports.LlmClient = exports.LlmError = void 0;
exports.healthCheck = healthCheck;
exports.resolveChunkChars = resolveChunkChars;
const types_1 = require("./types");
class LlmError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
    }
}
exports.LlmError = LlmError;
/** Error text that means "this server doesn't support the structured-output parameters we sent". */
const STRUCTURED_OUTPUT_ERROR = /response_format|json_schema|json_object|guided[_ ]|grammar|structured output|\bformat\b.*(not supported|unsupported|invalid)/i;
class LlmClient {
    cfg;
    log;
    /** Set when the server rejected structured output once; we stop asking for it. */
    jsonModeOverride;
    constructor(cfg, log = types_1.nullLogger) {
        this.cfg = cfg;
        this.log = log;
    }
    get model() {
        return this.cfg.model;
    }
    base() {
        let b = this.cfg.baseUrl.trim().replace(/\/+$/, '');
        if (this.cfg.provider === 'ollama')
            b = b.replace(/\/v1$/, '');
        return b;
    }
    headers() {
        const h = { 'Content-Type': 'application/json', ...(this.cfg.extraHeaders ?? {}) };
        if (this.cfg.apiKey)
            h.Authorization = `Bearer ${this.cfg.apiKey}`;
        return h;
    }
    async request(url, init, signal, timeoutMs = this.cfg.timeoutMs) {
        const signals = [AbortSignal.timeout(timeoutMs)];
        if (signal)
            signals.push(signal);
        let res;
        try {
            res = await fetch(url, { ...init, headers: this.headers(), signal: AbortSignal.any(signals) });
        }
        catch (e) {
            throw this.wrapNetworkError(e, url, signal, timeoutMs);
        }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            let msg = `${res.status} ${res.statusText} from ${url}`;
            const detail = extractErrorMessage(body);
            if (detail)
                msg += `: ${detail}`;
            if (res.status === 404 && this.cfg.provider === 'openai' && !/\/v\d+$/.test(this.base())) {
                msg += ' (OpenAI-compatible servers usually need the base URL to end in /v1)';
            }
            if (res.status === 401 || res.status === 403)
                msg += ' (check the API key: "Diff Leppard: Set LLM API Key")';
            throw new LlmError(msg, res.status, body);
        }
        return res;
    }
    wrapNetworkError(e, url, signal, timeoutMs) {
        const err = e;
        if (signal?.aborted)
            return new LlmError('Cancelled');
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
    async contextWindow(signal) {
        if (this.cfg.provider === 'ollama')
            return this.cfg.ollamaNumCtx;
        const res = await this.request(`${this.base()}/models`, { method: 'GET' }, signal, 15000);
        const json = (await res.json());
        const entry = (json.data ?? []).find((m) => m.id === this.cfg.model) ?? (json.data?.length === 1 ? json.data[0] : undefined);
        for (const k of ['max_model_len', 'context_window', 'context_length', 'max_context_length']) {
            const v = entry?.[k];
            if (typeof v === 'number' && v > 0)
                return v;
        }
        return undefined;
    }
    async listModels(signal) {
        if (this.cfg.provider === 'ollama') {
            const res = await this.request(`${this.base()}/api/tags`, { method: 'GET' }, signal, 15000);
            const json = (await res.json());
            return (json.models ?? []).map((m) => m.name);
        }
        const res = await this.request(`${this.base()}/models`, { method: 'GET' }, signal, 15000);
        const json = (await res.json());
        return (json.data ?? []).map((m) => m.id);
    }
    async chat(messages, opts = {}) {
        const mode = this.jsonModeOverride ?? this.cfg.jsonMode;
        try {
            return await this.chatOnce(messages, mode, opts);
        }
        catch (e) {
            if (e instanceof LlmError &&
                mode !== 'none' &&
                (e.status === 400 || e.status === 422) &&
                STRUCTURED_OUTPUT_ERROR.test(e.body ?? e.message)) {
                this.log.warn(`Server rejected structured output (${mode}); retrying without it. ${e.message}`);
                this.jsonModeOverride = 'none';
                return await this.chatOnce(messages, 'none', opts);
            }
            throw e;
        }
    }
    async chatOnce(messages, mode, opts) {
        return this.cfg.provider === 'ollama' ? this.chatOllama(messages, mode, opts) : this.chatOpenAI(messages, mode, opts);
    }
    async chatOpenAI(messages, mode, opts) {
        const body = {
            model: this.cfg.model,
            messages,
            temperature: this.cfg.temperature,
            max_tokens: opts.maxTokens ?? this.cfg.maxOutputTokens,
            stream: this.cfg.stream,
            ...(this.cfg.extraBody ?? {}),
        };
        if (mode === 'json_object')
            body.response_format = { type: 'json_object' };
        else if (mode === 'json_schema' && opts.schema) {
            body.response_format = { type: 'json_schema', json_schema: { name: 'code_review', schema: opts.schema } };
        }
        const url = `${this.base()}/chat/completions`;
        this.log.debug(`POST ${url} model=${this.cfg.model} json=${mode} stream=${this.cfg.stream}`);
        const res = await this.request(url, { method: 'POST', body: JSON.stringify(body) }, opts.signal);
        const ctype = res.headers.get('content-type') ?? '';
        if (!this.cfg.stream || !ctype.includes('text/event-stream')) {
            const json = (await res.json());
            const choice = json.choices?.[0];
            const content = choice?.message?.content ?? '';
            opts.onProgress?.(content.length);
            return { content, truncated: choice?.finish_reason === 'length' };
        }
        let content = '';
        let reasoning = 0;
        let truncated = false;
        await readLines(res, (line) => {
            if (!line.startsWith('data:'))
                return;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]')
                return;
            let evt;
            try {
                evt = JSON.parse(data);
            }
            catch {
                return;
            }
            if (evt.error)
                throw new LlmError(`Server error during streaming: ${extractErrorMessage(JSON.stringify(evt))}`);
            const choice = evt.choices?.[0];
            if (!choice)
                return;
            const delta = choice.delta ?? {};
            if (delta.content)
                content += delta.content;
            const r = delta.reasoning_content ?? delta.reasoning;
            if (r)
                reasoning += r.length;
            if (choice.finish_reason === 'length')
                truncated = true;
            opts.onProgress?.(content.length + reasoning);
        });
        return { content, truncated };
    }
    async chatOllama(messages, mode, opts) {
        const extra = { ...(this.cfg.extraBody ?? {}) };
        const extraOptions = extra.options ?? {};
        delete extra.options;
        const body = {
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
        if (mode === 'json_object')
            body.format = 'json';
        else if (mode === 'json_schema' && opts.schema)
            body.format = opts.schema;
        const url = `${this.base()}/api/chat`;
        this.log.debug(`POST ${url} model=${this.cfg.model} json=${mode} stream=${this.cfg.stream} num_ctx=${this.cfg.ollamaNumCtx}`);
        const res = await this.request(url, { method: 'POST', body: JSON.stringify(body) }, opts.signal);
        if (!this.cfg.stream) {
            const json = (await res.json());
            const content = json.message?.content ?? '';
            opts.onProgress?.(content.length);
            return { content, truncated: json.done_reason === 'length' };
        }
        let content = '';
        let thinking = 0;
        let truncated = false;
        await readLines(res, (line) => {
            if (!line.trim())
                return;
            let evt;
            try {
                evt = JSON.parse(line);
            }
            catch {
                return;
            }
            if (evt.error)
                throw new LlmError(`Ollama error: ${evt.error}`);
            if (evt.message?.content)
                content += evt.message.content;
            if (evt.message?.thinking)
                thinking += evt.message.thinking.length;
            if (evt.done && evt.done_reason === 'length')
                truncated = true;
            opts.onProgress?.(content.length + thinking);
        });
        return { content, truncated };
    }
}
exports.LlmClient = LlmClient;
async function readLines(res, onLine) {
    if (!res.body)
        return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finished = false;
    try {
        for (;;) {
            let chunk;
            try {
                chunk = await reader.read();
            }
            catch (e) {
                const name = e.name;
                if (name === 'TimeoutError')
                    throw new LlmError('Model request timed out while streaming (raise requestTimeoutSeconds, or diffLeppard.requestTimeoutSeconds in VS Code)');
                if (name === 'AbortError')
                    throw new LlmError('Cancelled');
                throw new LlmError(`Stream from model server failed: ${e.message}`);
            }
            const { done, value } = chunk;
            if (done)
                break;
            buf += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).replace(/\r$/, '');
                buf = buf.slice(nl + 1);
                onLine(line);
            }
        }
        buf += decoder.decode();
        if (buf.trim())
            onLine(buf.replace(/\r$/, ''));
        finished = true;
    }
    finally {
        // On an error event (or any throw) release the connection instead of leaving it open until the timeout.
        if (!finished)
            await reader.cancel().catch(() => undefined);
    }
}
/** A tiny request to check the server answers chat completions. Shared by the extension and the CLI. */
async function healthCheck(client, signal) {
    const t0 = Date.now();
    const r = await client.chat([
        { role: 'system', content: 'You are a health check. Respond with JSON only.' },
        { role: 'user', content: 'Respond with exactly {"ok": true}' },
    ], { signal, maxTokens: 256, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } });
    return { content: r.content, ms: Date.now() - t0 };
}
function extractErrorMessage(body) {
    if (!body)
        return '';
    try {
        const j = JSON.parse(body);
        const m = j?.error?.message ?? j?.error ?? j?.message ?? j?.detail;
        if (typeof m === 'string')
            return m.slice(0, 500);
        if (m)
            return JSON.stringify(m).slice(0, 500);
    }
    catch {
        /* not JSON */
    }
    return body.slice(0, 500);
}
/** Chunk size used when maxChunkChars is "auto" (0) and the server doesn't report a context window. */
exports.FALLBACK_CHUNK_CHARS = 24000;
/** Upper bound for auto-sized chunks: review quality drops on huge prompts even when they fit. */
exports.MAX_AUTO_CHUNK_CHARS = 100000;
const PROMPT_OVERHEAD_TOKENS = 1500;
/** Conservative: code is often denser than the usual ~3.5–4 chars/token. */
const CHARS_PER_TOKEN = 3;
/**
 * Resolve maxChunkChars. A positive value is used as-is; 0 means "auto": size requests to the model's
 * context window (minus the output budget and prompt overhead), falling back to FALLBACK_CHUNK_CHARS.
 */
async function resolveChunkChars(client, configured, maxOutputTokens, log, signal) {
    if (configured > 0)
        return configured;
    let ctx;
    try {
        ctx = await client.contextWindow(signal);
    }
    catch (e) {
        log.debug(`Could not read the model's context window: ${e.message}`);
    }
    if (!ctx) {
        log.info(`Server doesn't report a context window; using ${exports.FALLBACK_CHUNK_CHARS} diff characters per request (set maxChunkChars to override).`);
        return exports.FALLBACK_CHUNK_CHARS;
    }
    const available = ctx - maxOutputTokens - PROMPT_OVERHEAD_TOKENS;
    if (available < 1000) {
        log.warn(`maxOutputTokens (${maxOutputTokens}) leaves almost no room in the model's ${ctx}-token context; lower it or set maxChunkChars.`);
        return 2000;
    }
    const chars = Math.min(exports.MAX_AUTO_CHUNK_CHARS, Math.max(2000, available * CHARS_PER_TOKEN));
    log.info(`Model context is ${ctx} tokens → up to ${chars} diff characters per request.`);
    return chars;
}
