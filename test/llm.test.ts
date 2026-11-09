import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { parseUnifiedDiff } from '../src/diff';
import { LlmClient, LlmConfig } from '../src/llm';
import { runReview } from '../src/review';
import { nullLogger } from '../src/types';

const REVIEW = {
  summary: 'Introduces an off-by-one.',
  findings: [{ file: 'src/loop.js', line: 2, severity: 'major', category: 'bug', title: 'Off by one', body: 'Use < not <=' }],
};

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
        return res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }));
      }
      if (req.url === '/api/tags') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b' }] }));
      }
      if (req.url === '/v1/chat/completions') {
        if (json.model === 'strict' && json.response_format) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: { message: "response_format is not supported" } }));
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
  assert.deepEqual(await c.listModels(), ['m1', 'm2']);
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
