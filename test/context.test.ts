import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { agenticReply, runTool } from '../src/agent';
import {
  extractIdentifiers,
  extractPaths,
  findRelatedCode,
  gitRepoView,
  INDEX,
  loadGuidelines,
  planBudget,
  renderRelated,
  safeRepoPath,
  trimGuidelines,
} from '../src/context';
import { chunkDiff, contentMatchesDiff, parseUnifiedDiff, renderFileContext, renderWithContext } from '../src/diff';
import { commitMessages } from '../src/flow';
import { LlmClient, LlmConfig } from '../src/llm';
import { buildReviewMessages } from '../src/prompt';
import { runReview } from '../src/review';
import { nullLogger } from '../src/types';
import { codeForChange, evidenceInCode, findingTerms, verifyFindings } from '../src/verify';
import type { FileDiff } from '../src/types';

// ---------------------------------------------------------------------------
// A scratch git repo
// ---------------------------------------------------------------------------

let repo = '';
let from = '';
let to = '';
const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-02T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-02T00:00:00Z' } });

function write(rel: string, text: string) {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), text);
}

const CSS_BEFORE = Array.from({ length: 60 }, (_, i) => `.rule-${i} { margin: ${i}px; }`).join('\n') + '\n.card.full-width .card-inner { padding: 0; }\n';
const CSS_AFTER = CSS_BEFORE + '.card .card-inner { padding: 40px; }\n';

before(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'dl-ctx-'));
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  write('styles/card.css', CSS_BEFORE);
  write('data/rows/a.json', '{}');
  write('data/rows/b.json', '{}');
  write('data/README.md', '# Data\nThe rows/ snapshot predates the cleanup; re-export before importing.\n');
  write('scripts/import.py', 'SRC = ROOT / "data" / "rows"\n\ndef load():\n    return 1\n');
  write('scripts/other.py', 'from scripts.import import fetch_items\nfetch_items()\n');
  write('AGENTS.md', '# Guide\nIntro.\n\n## Style\n' + 'x'.repeat(400) + '\n\n## Deploys\nMerging to main deploys to production.\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  from = g('rev-parse', 'HEAD').trim();
  write('styles/card.css', CSS_AFTER);
  write('scripts/import.py', 'SRC = ROOT / "data" / "rows"\n\ndef fetch_items():\n    return 2\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'Card padding and rename', '-m', 'Only affects cards without full-width.');
  to = g('rev-parse', 'HEAD').trim();
});

function rangeDiff(ctx = 3) {
  return parseUnifiedDiff(g('diff', `-U${ctx}`, from, to));
}

// ---------------------------------------------------------------------------

test('safeRepoPath refuses escapes and git internals', () => {
  assert.equal(safeRepoPath('a/b.txt'), 'a/b.txt');
  assert.equal(safeRepoPath('./a/'), 'a');
  for (const bad of ['../x', '/etc/passwd', 'a/../../x', '.git/config', 'C:/x', '-rf', '']) assert.equal(safeRepoPath(bad), undefined, bad);
});

test('renderWithContext shows the whole file or widened hunks with markers and removed lines', () => {
  const files = parseUnifiedDiff(`diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -4,3 +4,3 @@
 four
-five
+FIVE
 six
`);
  const content = ['one', 'two', 'three', 'four', 'FIVE', 'six', 'seven', 'eight', 'nine', 'ten'].join('\n') + '\n';
  assert.ok(contentMatchesDiff(files[0], content));
  assert.ok(!contentMatchesDiff(files[0], content.replace('FIVE', 'five')));
  const whole = renderWithContext(files[0], content, Infinity);
  assert.match(whole, /@@ whole file, 10 lines @@/);
  assert.match(whole, /^ {4} - five\n {3}5 \+ FIVE$/m);
  assert.match(whole, /^ {3}1 {3}one$/m);
  assert.match(whole, /^ {2}10 {3}ten$/m);
  const near = renderWithContext(files[0], content, 1);
  assert.match(near, /@@ lines 3-7 @@/);
  assert.doesNotMatch(near, /two/);
  files[0].content = content;
  assert.equal(renderFileContext(files[0], 10000)?.whole, true);
  assert.equal(renderFileContext(files[0], 60), undefined);
});

test('chunkDiff renders loaded files whole when they fit, hunks otherwise', () => {
  const files = rangeDiff();
  const css = files.find((f) => f.path === 'styles/card.css')!;
  css.content = CSS_AFTER;
  const whole = chunkDiff(files, 20000, { contextChars: 10000 });
  assert.match(whole[0].text, /=== File: styles\/card\.css \(modified, whole file\) ===/);
  assert.match(whole[0].text, /card\.full-width \.card-inner \{ padding: 0; \}/);
  const plain = chunkDiff(files, 20000);
  assert.doesNotMatch(plain[0].text, /whole file/);
  assert.doesNotMatch(plain[0].text, /\.rule-3 /);
  // The model sees the context rules only when something was widened.
  const msgs = buildReviewMessages(whole[0], { chunkIndex: 0, chunkCount: 1, widened: true });
  assert.match(msgs[0].content, /equal specificity resolves by source order/);
  assert.doesNotMatch(buildReviewMessages(plain[0], { chunkIndex: 0, chunkCount: 1 })[0].content, /equal specificity/);
});

test('extractIdentifiers and extractPaths', () => {
  const files = rangeDiff();
  const py = files.find((f) => f.path === 'scripts/import.py')!;
  py.content = 'SRC = ROOT / "data" / "rows"\n\ndef fetch_items():\n    return 2\n';
  const ids = extractIdentifiers(py);
  assert.ok(ids.needles.includes('fetch_items'));
  assert.ok(ids.paths.includes('data/rows'));
  assert.ok(extractIdentifiers(files.find((f) => f.path === 'styles/card.css')!).needles.includes('.card-inner'));
  assert.deepEqual(extractPaths('see https://x.y/a/b and "src/lib/*.ts" and join("a", "b") and docs/guide.md'), ['src/lib', 'a/b', 'docs/guide.md']);
});

test('gitRepoView reads, searches and lists at a commit; stays inside the repo', async () => {
  const v = gitRepoView(repo, to);
  assert.equal(await v.read('styles/card.css'), CSS_AFTER);
  assert.equal(await gitRepoView(repo, from).read('styles/card.css'), CSS_BEFORE);
  assert.equal(await v.read('../etc/passwd'), undefined);
  assert.equal(await v.read('nope.txt'), undefined);
  const hits = await v.grep!(['fetch_items'], 10);
  assert.deepEqual(hits.map((h) => `${h.path}:${h.line}`).sort(), ['scripts/import.py:3', 'scripts/other.py:1', 'scripts/other.py:2']);
  assert.deepEqual(await v.list!('data/rows', 10), ['data/rows/a.json', 'data/rows/b.json']);
  assert.match((await v.lastChange!('data/rows'))!, /^[0-9a-f]+ 2026-01-02 base$/);
  // Working tree: an untracked symlink out of the repo is not readable.
  const outside = mkdtempSync(path.join(tmpdir(), 'dl-out-'));
  writeFileSync(path.join(outside, 'secret'), 'secret');
  symlinkSync(path.join(outside, 'secret'), path.join(repo, 'link'));
  assert.equal(await gitRepoView(repo).read('link'), undefined);
});

test('findRelatedCode finds other uses, named folders with their README, and ranks them', async () => {
  const files = rangeDiff();
  const v = gitRepoView(repo, to);
  for (const f of files) f.content = await v.read(f.path);
  const rel = await findRelatedCode(files, v, { exclude: () => false, log: nullLogger });
  const py = rel.get('scripts/import.py')!;
  assert.ok(py, 'related code for the script');
  const paths = py.map((s) => s.path);
  assert.ok(paths.includes('data/rows/'), paths.join());
  assert.ok(paths.includes('data/README.md'), paths.join());
  assert.ok(paths.includes('scripts/other.py'), paths.join());
  const text = renderRelated(py, 4000);
  assert.match(text, /last changed by commit [0-9a-f]+ 2026-01-02 base/);
  assert.match(text, /predates the cleanup/);
  assert.ok(renderRelated(py, 400).length <= 450);
});

test('planBudget scales with the context window', () => {
  const s = { fullFileMaxChars: 40000, relatedMaxChars: 6000, maxInstructionsChars: 8000 };
  const big = planBudget(100000, s);
  assert.deepEqual(big, { instructions: 8000, related: 6000, fullFile: 40000 });
  const small = planBudget(12000, s);
  assert.equal(small.instructions, 1800);
  assert.equal(small.related, 2400);
  assert.ok(small.fullFile <= 12000 - 1800 - 2400);
  assert.equal(planBudget(100000, { ...s, fullFileMaxChars: 0 }).fullFile, 0);
  for (const total of [1000, 2000, 5000, 12000, 30000, 100000]) {
    const b = planBudget(total, s);
    assert.ok(b.instructions + b.related + b.fullFile <= total, `parts fit in ${total}`);
  }
});

test('guidelines: configured file first, then AGENTS.md; long guides keep key sections', async () => {
  const v = gitRepoView(repo, to);
  const gd = await loadGuidelines(v, '.github/code-review-instructions.md', ['AGENTS.md'], 8000, nullLogger);
  assert.equal(gd?.source, 'AGENTS.md');
  assert.equal(await loadGuidelines(v, '', [], 8000, nullLogger), undefined);
  const trimmed = trimGuidelines((await v.read('AGENTS.md'))!, 200);
  assert.match(trimmed, /## Deploys\nMerging to main deploys to production\./);
  assert.match(trimmed, /## Style/);
  assert.ok(trimmed.length <= 230);
});

test('commitMessages turns a range into a title and description', async () => {
  assert.deepEqual(await commitMessages(repo, `${from}..${to}`), { title: 'Card padding and rename', description: 'Only affects cards without full-width.' });
  assert.equal(await commitMessages(repo, '--all'), undefined);
});

test('evidenceInCode ignores line numbers and whitespace, rejects invented code', () => {
  const code = '=== File: a.html ===\n  12 + <p><span>Hi</span></p>\n  13   {% if href %}<a href="{{ href }}">x</a>{% endif %}';
  assert.ok(evidenceInCode('  12 + <p><span>Hi</span></p>', code));
  assert.ok(evidenceInCode('{% if href %}<a href="{{ href }}">x</a>{% endif %}', code));
  assert.ok(!evidenceInCode('<p><div>Hi</div></p>', code));
  assert.ok(!evidenceInCode('', code));
});

test('agent tools are read-only and confined to the repo', async () => {
  const o = { view: gitRepoView(repo, to), before: gitRepoView(repo, from), maxToolCalls: 5, budgetChars: 10000, exclude: (p: string) => p.endsWith('.lock') };
  assert.match(await runTool('read_file', { path: 'scripts/import.py' }, o), /3 {2}def fetch_items/);
  assert.match(await runTool('read_file', { path: 'scripts/import.py', before: true }, o), /def load\(\)/);
  assert.match(await runTool('read_file', { path: '../../etc/passwd' }, o), /^error/);
  assert.match(await runTool('read_file', { path: 'x.lock' }, o), /excluded/);
  assert.match(await runTool('grep', { text: 'fetch_items', path_glob: 'scripts/other.py' }, o), /^scripts\/other\.py:1:/);
  assert.match(await runTool('list_dir', { path: 'data/rows' }, o), /2 files, last changed by commit/);
  assert.match(await runTool('rm', {}, o), /unknown tool/);
});

// ---------------------------------------------------------------------------
// Against a scripted mock server: verification and the agent loop
// ---------------------------------------------------------------------------

let server: http.Server;
let base = '';
const replies: object[] = [];
const seen: any[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      seen.push(parsed);
      const next = replies.shift() ?? { content: '{"summary":"ok","findings":[]}' };
      res.setHeader('content-type', 'application/json');
      const { status, error, finish, ...message } = next as { status?: number; error?: string; finish?: string };
      if (status) {
        res.statusCode = status;
        res.end(JSON.stringify({ error: { message: error } }));
      } else res.end(JSON.stringify({ choices: [{ finish_reason: finish ?? 'stop', message }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => server.close());

const cfg = (): LlmConfig => ({ provider: 'openai', baseUrl: base, model: 'm', temperature: 0, maxOutputTokens: 512, jsonMode: 'json_object', stream: false, timeoutMs: 5000, ollamaNumCtx: 4096 });

test('verification drops rejected findings, keeps confirmed ones, demotes unsure', async () => {
  const files = rangeDiff();
  const css = files.find((f) => f.path === 'styles/card.css')!;
  css.content = CSS_AFTER;
  const finding = (title: string, severity = 'major') => ({ file: 'styles/card.css', line: 62, severity, title, body: 'b' });
  replies.length = 0;
  seen.length = 0;
  replies.push({ content: JSON.stringify({ summary: 's', findings: [finding('Real'), finding('Wrong', 'critical'), finding('Maybe'), finding('Fake quote'), finding('Tiny', 'minor')] }) });
  replies.push({ content: '{"verdict":"rejected","evidence":".card .card-inner { padding: 40px; }","reason":"no"}' }); // critical sorts first
  replies.push({ content: '{"verdict":"confirmed","evidence":".card.full-width .card-inner { padding: 0; }","reason":"tie"}' });
  replies.push({ content: '{"verdict":"unsure","evidence":"","reason":"?"}' });
  replies.push({ content: '{"verdict":"confirmed","evidence":"<div>made up</div>","reason":"x"}' });
  const result = await runReview(files, {
    llm: new LlmClient(cfg()),
    maxChunkChars: 20000,
    contextChars: 10000,
    concurrency: 1,
    minimumSeverity: 'nit',
    exclude: () => false,
    context: {},
    log: nullLogger,
    verify: 'critical-major',
  });
  const by = Object.fromEntries(result.findings.map((f) => [f.title, f]));
  assert.deepEqual(result.rejectedFindings?.map((f) => f.title), ['Wrong']);
  assert.equal(by.Real.verified, true);
  assert.equal(by.Maybe.severity, 'minor');
  assert.equal(by['Fake quote'].severity, 'minor', 'a confirmation quoting code that is not there counts as unsure');
  assert.equal(by.Tiny.verified, undefined, 'minor findings are not verified in critical-major mode');
  assert.equal(seen.length, 5);
  assert.match(seen[1].messages[1].content, /=== File: styles\/card\.css ===/);
});

test('agentic mode runs tools, then parses the answer; stops at the tool budget', async () => {
  const files = rangeDiff();
  replies.length = 0;
  seen.length = 0;
  replies.push({ content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{"text":"fetch_items"}' } }] });
  replies.push({ content: '{"summary":"s","findings":[{"file":"scripts/import.py","line":3,"severity":"major","title":"Rename breaks other.py","body":"b"}]}' });
  const result = await runReview(files, {
    llm: new LlmClient(cfg()),
    maxChunkChars: 20000,
    concurrency: 1,
    minimumSeverity: 'minor',
    exclude: () => false,
    context: {},
    log: nullLogger,
    agent: { view: gitRepoView(repo, to), maxToolCalls: 3, exclude: () => false },
  });
  assert.deepEqual(result.findings.map((f) => f.title), ['Rename breaks other.py']);
  assert.equal(seen[0].tools.length, 3);
  const toolMsg = seen[1].messages.find((m: any) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'c1');
  assert.match(toolMsg.content, /scripts\/other\.py:1:/);

  // Budget: every reply asks for a tool; after maxToolCalls we ask for the answer without tools.
  replies.length = 0;
  seen.length = 0;
  for (let i = 0; i < 2; i++) replies.push({ content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'list_dir', arguments: '{"path":"data"}' } }] });
  replies.push({ content: '{"summary":"done","findings":[]}' });
  const a = await agenticReply(new LlmClient(cfg()), [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], { view: gitRepoView(repo, to), maxToolCalls: 2, budgetChars: 10000, exclude: () => false }, nullLogger);
  assert.equal(a.toolCalls, 2);
  assert.equal(a.content, '{"summary":"done","findings":[]}');
  assert.equal(seen.at(-1).tools, undefined, 'the last request has no tools');
});

test('verification keeps findings when the check gives no answer, and never demotes below the threshold', async () => {
  const files = rangeDiff();
  files.find((f) => f.path === 'styles/card.css')!.content = CSS_AFTER;
  const finding = (title: string) => ({ file: 'styles/card.css', line: 62, severity: 'major', title, body: 'b' });
  replies.length = 0;
  seen.length = 0;
  replies.push({ content: JSON.stringify({ summary: 's', findings: [finding('Cut off'), finding('Unsure')] }) });
  replies.push({ content: '<think>still going', finish: 'length' });
  replies.push({ content: '{"verdict":"unsure","evidence":"","reason":"?"}' });
  const result = await runReview(files, {
    llm: new LlmClient(cfg()),
    maxChunkChars: 20000,
    concurrency: 1,
    minimumSeverity: 'major',
    exclude: () => false,
    context: {},
    log: nullLogger,
    verify: 'critical-major',
  });
  assert.deepEqual(result.findings.map((f) => [f.title, f.severity]), [['Cut off', 'major'], ['Unsure', 'major']]);
  assert.equal(result.rejectedFindings, undefined);
  assert.equal(seen[1].max_tokens, 512, 'verification uses the normal output budget');
});

test('verification checks findings outside the change: unchanged files from the repo, unnamed ones against the whole change', async () => {
  const files = rangeDiff();
  const finding = (file: string, title: string) => ({ file, line: 2, severity: 'major', title, body: 'b' });
  replies.length = 0;
  seen.length = 0;
  replies.push({ content: JSON.stringify({ summary: 's', findings: [finding('scripts/other.py', 'Blames a context file'), finding('', 'Names no file'), finding('data/README.md', 'Excluded file')] }) });
  replies.push({ content: '{"verdict":"rejected","evidence":"","reason":"not in the change"}' });
  replies.push({ content: '{"verdict":"rejected","evidence":"","reason":"no such code"}' });
  replies.push({ content: '{"verdict":"rejected","evidence":"","reason":"no"}' });
  const result = await runReview(files, {
    llm: new LlmClient(cfg()),
    maxChunkChars: 20000,
    concurrency: 1,
    minimumSeverity: 'nit',
    exclude: (p) => p.startsWith('data/'),
    context: {},
    log: nullLogger,
    verify: 'critical-major',
    view: gitRepoView(repo, to),
  });
  assert.deepEqual(result.findings, [], 'all three were checked and rejected');
  assert.equal(seen.length, 4);
  const asked = seen.slice(1).map((r) => r.messages[1].content as string);
  const byTitle = (t: string) => asked.find((c) => c.includes(`Title: ${t}`))!;
  // The unchanged file is read from the reviewed commit and shown together with the change.
  assert.match(byTitle('Blames a context file'), /=== File: scripts\/other\.py \(not shown as part of the change/);
  assert.match(byTitle('Blames a context file'), /fetch_items\(\)/);
  assert.match(byTitle('Blames a context file'), /The change under review:/);
  // No file named, or an excluded one: checked against the whole change, without reading the excluded file.
  for (const t of ['Names no file', 'Excluded file']) {
    assert.match(byTitle(t), /=== File: scripts\/import\.py/);
    assert.doesNotMatch(byTitle(t), /not shown as part of the change/);
  }
  assert.doesNotMatch(byTitle('Excluded file'), /re-export before importing/, 'the excluded file is never read');
});

test('codeForChange puts the files and hunks a finding mentions first and stays within budget', () => {
  const hunk = (start: number, body: string[]) => ({
    header: '',
    oldStart: start,
    oldLines: 0,
    newStart: start,
    newLines: body.length,
    lines: body.map((text, i) => ({ kind: 'add' as const, text, newLine: start + i })),
  });
  const mk = (p: string, hunks: FileDiff['hunks']): FileDiff => ({ path: p, status: 'modified', binary: false, hunks });
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `const filler${i} = ${i};`);
  const files = [
    ...Array.from({ length: 10 }, (_, i) => mk(`src/f${i}.js`, [hunk(1, filler(20))])),
    mk('src/target.js', [hunk(1, filler(60)), hunk(200, ['function parseToken(raw) {', '  return raw.split(".")[1];', '}'])]),
  ];
  assert.deepEqual(findingTerms({ title: 'parseToken drops the header', body: 'In `raw.split` the first part is lost.' }).sort(), ['parsetoken', 'raw.split']);
  const f = { title: 'parseToken drops the header', body: 'In `raw.split` the first part is lost.' };
  for (const max of [600, 1500, 4000, 20000]) {
    const out = codeForChange(files, max, f);
    assert.ok(out.length <= max, `within ${max}: got ${out.length}`);
  }
  const out = codeForChange(files, 1500, f);
  assert.match(out, /^=== File: src\/target\.js/, 'the file the finding is about comes first');
  assert.match(out, /parseToken\(raw\)/, 'its matching hunk is kept even though an earlier hunk is too big');
  assert.match(codeForChange(files, 20000, f), /\(3 more changed file\(s\) not shown: /);
  assert.equal(codeForChange(files, 0, f), '');
});

test('verification labels a finding on a changed file the review skipped as changed', async () => {
  const files = rangeDiff();
  replies.length = 0;
  seen.length = 0;
  replies.push({ content: '{"verdict":"confirmed","evidence":"","reason":""}' });
  const f = { file: 'scripts/other.py', line: 2, severity: 'major' as const, title: 'Too big to show', body: 'b', inline: false };
  await verifyFindings([f], files, { llm: new LlmClient(cfg()), mode: 'critical-major', maxChars: 20000, concurrency: 1, log: nullLogger, view: gitRepoView(repo, to), changedNotShown: ['scripts/other.py'] });
  const asked = seen[0].messages[1].content as string;
  assert.match(asked, /=== File: scripts\/other\.py \(changed by this change, but too large to show its diff/);
  assert.doesNotMatch(asked, /not shown as part of the change/);
});

test('verification lowers a serious finding it has no code to check against', async () => {
  replies.length = 0;
  seen.length = 0;
  const f = { file: 'gone.js', line: 1, severity: 'critical' as const, title: 'Unverifiable', body: 'b', inline: false };
  const v = await verifyFindings([f], [], { llm: new LlmClient(cfg()), mode: 'critical-major', maxChars: 10000, concurrency: 1, log: nullLogger });
  assert.deepEqual(v.kept.map((x) => x.severity), ['major']);
  assert.equal(seen.length, 0, 'no request without code');
  const kept = await verifyFindings([{ ...f, severity: 'major' }], [], { llm: new LlmClient(cfg()), mode: 'critical-major', minimumSeverity: 'major', maxChars: 10000, concurrency: 1, log: nullLogger });
  assert.equal(kept.kept[0].severity, 'major', 'never below the threshold');
});

test('the description check runs only when one request sees the whole change', () => {
  const chunk = { files: [], text: 'x' };
  const one = buildReviewMessages(chunk, { description: 'Adds a guard', checkDescription: true, chunkIndex: 0, chunkCount: 1 });
  assert.match(one[0].content, /Check each concrete claim/);
  const split = buildReviewMessages(chunk, { description: 'Adds a guard', checkDescription: true, chunkIndex: 0, chunkCount: 2 });
  assert.doesNotMatch(split[0].content, /Check each concrete claim/);
});

test('commitMessages for --base lists only the branch\'s own commits', async () => {
  g('checkout', '-q', '-b', 'side', from);
  write('side.txt', 'x\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'Side change');
  try {
    assert.deepEqual(await commitMessages(repo, 'main..HEAD'), { title: 'Side change', description: '' });
  } finally {
    g('checkout', '-q', 'main');
  }
});

test('the index view shows staged content, not unstaged edits', async () => {
  const file = path.join(repo, 'scripts/other.py');
  const original = readFileSync(file, 'utf8');
  try {
    writeFileSync(file, 'STAGED\n' + original);
    g('add', 'scripts/other.py');
    writeFileSync(file, 'STAGED\n' + original + 'UNSTAGED\n');
    const idx = gitRepoView(repo, INDEX);
    assert.equal(await idx.read('scripts/other.py'), 'STAGED\n' + original);
    assert.ok((await idx.grep!(['STAGED'], 5)).every((h) => h.path === 'scripts/other.py'));
    assert.equal((await idx.grep!(['UNSTAGED'], 5)).length, 0);
    assert.ok((await idx.list!('scripts', 10))!.includes('scripts/other.py'));
  } finally {
    writeFileSync(file, original);
    g('add', 'scripts/other.py');
  }
});

test('agent tools apply excludes to the normalised path, and to list_dir results', async () => {
  const exclude = (p: string) => p.startsWith('data/rows/');
  const o = { view: gitRepoView(repo, to), maxToolCalls: 5, budgetChars: 10000, exclude };
  for (const p of ['data/rows/a.json', './data/rows/a.json', 'data\\rows\\a.json']) assert.match(await runTool('read_file', { path: p }, o), /excluded/, p);
  const listing = await runTool('list_dir', { path: 'data' }, o);
  assert.match(listing, /data\/README\.md/);
  assert.doesNotMatch(listing, /rows/);
});

test('removed lines from a -U0 deletion-only hunk sit after the line before them', () => {
  const files = parseUnifiedDiff(`diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -3 +2,0 @@
-c
`);
  const out = renderWithContext(files[0], 'a\nb\nd\n', Infinity);
  assert.match(out, /^ {3}2 {3}b\n {4} - c\n {3}3 {3}d$/m);
});

test('agentic mode falls back to a normal review when the server rejects tools', async () => {
  const files = rangeDiff();
  replies.length = 0;
  seen.length = 0;
  replies.push({ status: 400, error: '"auto" tool choice requires --enable-auto-tool-choice' });
  replies.push({ content: '{"summary":"plain","findings":[]}' });
  const result = await runReview(files, {
    llm: new LlmClient(cfg()),
    maxChunkChars: 20000,
    concurrency: 1,
    minimumSeverity: 'minor',
    exclude: () => false,
    context: {},
    log: nullLogger,
    agent: { view: gitRepoView(repo, to), maxToolCalls: 3, exclude: () => false },
  });
  assert.equal(result.summary, 'plain');
  assert.equal(seen[1].tools, undefined);
});
