import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { parseUnifiedDiff } from '../src/diff';
import { FALLBACK_CHUNK_CHARS, findRepetitionLoop, LlmClient, LlmConfig, MAX_AUTO_CHUNK_CHARS, resolveChunkChars } from '../src/llm';
import { runReview } from '../src/review';
import { nullLogger } from '../src/types';

const REVIEW = {
  summary: 'Introduces an off-by-one.',
  findings: [{ file: 'src/loop.js', line: 2, severity: 'major', category: 'bug', title: 'Off by one', body: 'Use < not <=' }],
};

const FINDING = JSON.stringify(REVIEW.findings[0]);
/** Streams that never end on their own: [prefix, repeated unit]. */
const LOOPS: Record<string, [string, string]> = {
  'loopy-findings': ['{"summary": "Introduces an off-by-one.", "findings": [', FINDING + ', '],
  'loopy-whitespace': [JSON.stringify(REVIEW).slice(0, -1), '\n'],
};
/** Per loop model: how many chunks the server sent before the client hung up (or -1 if it never did). */
const loopChunksSent: Record<string, number> = {};

const requests: any[] = [];
let server: http.Server;
let base = '';

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : undefined;
      requests.push({ url: req.url, auth: req.headers.authorization, body: json });
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'm1', max_model_len: 32768 }, { id: 'm2' }, { id: 'tiny', context_window: 4096 }] }));
      }
      if (req.url === '/api/tags') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b' }] }));
      }
      if (req.url === '/v1/chat/completions') {
        if (json.model === 'broken') {
          res.statusCode = 500;
          return res.end(JSON.stringify({ error: { message: 'Internal error, see logs for more information' } }));
        }
        if (json.model === 'strict' && json.response_format) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: { message: "response_format is not supported" } }));
        }
        const loop = LOOPS[json.model];
        if (loop && json.stream) {
          res.setHeader('content-type', 'text/event-stream');
          const send = (text: string) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
          send(loop[0]);
          let sent = 0;
          let closed = false;
          res.on('close', () => {
            closed = true;
            loopChunksSent[json.model] = sent;
          });
          const tick = () => {
            if (closed) return;
            if (sent >= 20000) {
              loopChunksSent[json.model] = -1;
              return res.end('data: [DONE]\n\n');
            }
            for (let k = 0; k < 20; k++, sent++) send(loop[1]);
            setImmediate(tick);
          };
          return tick();
        }
        const content = '<think>hmm</think>' + JSON.stringify(REVIEW);
        if (json.stream) {
          res.setHeader('content-type', 'text/event-stream');
          for (let i = 0; i < content.length; i += 7) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + 7) } }] })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
          return res.end('data: [DONE]\n\n');
        }
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'length' }] }));
      }
      if (req.url === '/api/chat') {
        const content = JSON.stringify(REVIEW);
        res.setHeader('content-type', 'application/x-ndjson');
        for (let i = 0; i < content.length; i += 10) res.write(JSON.stringify({ message: { content: content.slice(i, i + 10) }, done: false }) + '\n');
        return res.end(JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' }) + '\n');
      }
      res.statusCode = 404;
      res.end('{"error":"not found"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const cfg = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  provider: 'openai',
  baseUrl: `${base}/v1`,
  model: 'm1',
  temperature: 0,
  maxOutputTokens: 512,
  jsonMode: 'json_object',
  stream: true,
  timeoutMs: 5000,
  ollamaNumCtx: 8192,
  ...over,
});

test('openai: list models, streaming, api key, response_format', async () => {
  const c = new LlmClient(cfg({ apiKey: 'sekrit' }));
  assert.deepEqual(await c.listModels(), ['m1', 'm2', 'tiny']);
  let progress = 0;
  const r = await c.chat([{ role: 'user', content: 'hi' }], { onProgress: (n) => (progress = n) });
  assert.ok(r.content.endsWith(JSON.stringify(REVIEW)));
  assert.equal(r.truncated, false);
  assert.ok(progress > 50);
  const last = requests.at(-1);
  assert.equal(last.auth, 'Bearer sekrit');
  assert.deepEqual(last.body.response_format, { type: 'json_object' });
  assert.equal(last.body.max_tokens, 512);
});

test('openai: non-streaming reports truncation', async () => {
  const r = await new LlmClient(cfg({ stream: false })).chat([{ role: 'user', content: 'hi' }]);
  assert.equal(r.truncated, true);
});

test('openai: falls back when server rejects structured output', async () => {
  const c = new LlmClient(cfg({ model: 'strict', jsonMode: 'json_schema' }));
  const r = await c.chat([{ role: 'user', content: 'hi' }], { schema: { type: 'object' } });
  assert.ok(r.content.includes('Off by one'));
  assert.equal(requests.at(-1).body.response_format, undefined);
});

test('openai: helpful errors', async () => {
  await assert.rejects(new LlmClient(cfg({ baseUrl: base })).listModels(), /end in \/v1/);
  await assert.rejects(new LlmClient(cfg({ baseUrl: 'http://127.0.0.1:65531/v1' })).listModels(), /Could not reach .*ECONNREFUSED/);
});

test('findRepetitionLoop: catches loops, keeps one copy, ignores normal repetition', () => {
  // Whitespace runaway: keep the JSON and one newline.
  const ws = '{"summary": "s", "findings": []' + '\n'.repeat(5000);
  assert.equal(findRepetitionLoop(ws), ws.indexOf('\n') + 1);
  // The same finding over and over: keep exactly one copy.
  const head = '{"summary": "s", "findings": [';
  const looped = head + (FINDING + ', ').repeat(12);
  assert.equal(looped.slice(0, findRepetitionLoop(looped)), head + FINDING + ', ');
  // A longer span (a big finding) still needs only a few copies.
  const big = 'x'.repeat(10) + ('{"title": "' + 'abcdefghij'.repeat(90) + '"}, ').repeat(5);
  assert.ok(findRepetitionLoop(big) !== undefined);
  // Not loops: a normal review, a suggestion with a few identical lines, short text.
  assert.equal(findRepetitionLoop(JSON.stringify(REVIEW)), undefined);
  const suggestion = JSON.stringify({ findings: [{ suggestion: '    assert.ok(thing);\n'.repeat(10) + 'done();' }] });
  assert.equal(findRepetitionLoop(suggestion), undefined);
  assert.equal(findRepetitionLoop('    '.repeat(40)), undefined);
  assert.equal(findRepetitionLoop(''), undefined);
});

test('openai: stops a runaway stream early and hangs up so the server stops generating', async () => {
  for (const model of Object.keys(LOOPS)) {
    const t0 = Date.now();
    const r = await new LlmClient(cfg({ model, maxOutputTokens: 100000 })).chat([{ role: 'user', content: 'hi' }]);
    assert.equal(r.runaway, true, model);
    assert.equal(r.truncated, true, model);
    assert.ok(r.content.length < 2000, `${model}: kept ${r.content.length} chars`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(loopChunksSent[model] >= 0 && loopChunksSent[model] < 2000, `${model}: server sent ${loopChunksSent[model]} chunks`);
    assert.ok(Date.now() - t0 < 4000, model);
  }
});

test('runReview salvages the findings from a runaway reply', async () => {
  const files = parseUnifiedDiff(`diff --git a/src/loop.js b/src/loop.js
--- a/src/loop.js
+++ b/src/loop.js
@@ -1,3 +1,3 @@
 const xs = [1, 2, 3];
-for (let i = 0; i < xs.length; i++) {
+for (let i = 0; i <= xs.length; i++) {
   use(xs[i]);
`);
  const result = await runReview(files, {
    llm: new LlmClient(cfg({ model: 'loopy-findings' })),
    maxChunkChars: 10000,
    concurrency: 1,
    minimumSeverity: 'minor',
    exclude: () => false,
    context: { title: 'Loop fix' },
    log: nullLogger,
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].title, 'Off by one');
});

test('ollama native: tags, NDJSON streaming, num_ctx and format', async () => {
  const c = new LlmClient(cfg({ provider: 'ollama', baseUrl: `${base}/v1`, model: 'qwen2.5-coder:7b' }));
  assert.deepEqual(await c.listModels(), ['qwen2.5-coder:7b']);
  const r = await c.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(r.content, JSON.stringify(REVIEW));
  const last = requests.at(-1);
  assert.equal(last.url, '/api/chat');
  assert.equal(last.body.options.num_ctx, 8192);
  assert.equal(last.body.format, 'json');
});

test('runReview end to end against the mock server', async () => {
  const files = parseUnifiedDiff(`diff --git a/src/loop.js b/src/loop.js
--- a/src/loop.js
+++ b/src/loop.js
@@ -1,3 +1,3 @@
 const xs = [1, 2, 3];
-for (let i = 0; i < xs.length; i++) {
+for (let i = 0; i <= xs.length; i++) {
   use(xs[i]);
diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
-{}
+{"a":1}
`);
  const result = await runReview(files, {
    llm: new LlmClient(cfg()),
    maxChunkChars: 10000,
    concurrency: 2,
    minimumSeverity: 'minor',
    exclude: (p) => p.endsWith('package-lock.json'),
    context: { title: 'Loop fix' },
    log: nullLogger,
  });
  assert.equal(result.summary, REVIEW.summary);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(
    [result.findings[0].file, result.findings[0].line, result.findings[0].inline],
    ['src/loop.js', 2, true],
  );
  assert.deepEqual(result.skippedFiles.map((s) => s.path), ['package-lock.json']);
  const prompt = requests.at(-1).body.messages[1].content as string;
  assert.match(prompt, /Change title: Loop fix/);
  assert.match(prompt, /   2 \+ for \(let i = 0; i <= xs\.length; i\+\+\) \{/);
});

test('extraBody is merged into OpenAI and Ollama requests', async () => {
  await new LlmClient(cfg({ extraBody: { chat_template_kwargs: { enable_thinking: false }, top_k: 20 } })).chat([{ role: 'user', content: 'x' }]);
  assert.deepEqual(requests.at(-1).body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(requests.at(-1).body.top_k, 20);
  await new LlmClient(cfg({ provider: 'ollama', baseUrl: base, extraBody: { think: false, options: { top_k: 5 } } })).chat([{ role: 'user', content: 'x' }]);
  const b = requests.at(-1).body;
  assert.equal(b.think, false);
  assert.deepEqual([b.options.top_k, b.options.num_ctx], [5, 8192]);
});

test('generic server errors do not switch off structured output', async () => {
  const c = new LlmClient(cfg({ model: 'broken' }));
  const before = requests.length;
  await assert.rejects(c.chat([{ role: 'user', content: 'x' }]), /500/);
  assert.equal(requests.length - before, 1, 'no retry without response_format');
});

test('auto chunk size follows the reported context window', async () => {
  assert.equal(await resolveChunkChars(new LlmClient(cfg({ model: 'm1' })), 0, 4096, nullLogger), (32768 - 4096 - 1500) * 3);
  assert.equal(await resolveChunkChars(new LlmClient(cfg({ model: 'm2' })), 0, 4096, nullLogger), FALLBACK_CHUNK_CHARS);
  assert.equal(await resolveChunkChars(new LlmClient(cfg({ model: 'tiny' })), 0, 4096, nullLogger), 2000, 'no room left → minimum');
  assert.equal(await resolveChunkChars(new LlmClient(cfg({ model: 'm1' })), 12345, 4096, nullLogger), 12345, 'explicit wins');
  assert.equal(
    await resolveChunkChars(new LlmClient(cfg({ provider: 'ollama', baseUrl: base, ollamaNumCtx: 131072 })), 0, 4096, nullLogger),
    MAX_AUTO_CHUNK_CHARS,
  );
  assert.equal(await resolveChunkChars(new LlmClient(cfg({ baseUrl: 'http://127.0.0.1:65531/v1' })), 0, 4096, nullLogger), FALLBACK_CHUNK_CHARS);
});
