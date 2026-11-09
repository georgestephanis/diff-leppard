import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotateFile, chunkDiff, commentableLines, fileDiffFromContent, makeExcluder, parsePatchHunks, parseUnifiedDiff } from '../src/diff';
import { buildReviewPayload, formatCommentBody, parsePrReference, parseRemoteUrl, webHostFromApiUrl } from '../src/github';
import { parseModelOutput, stripThinking } from '../src/parse';
import { cleanPath, mapLines, normalizeFindings, normalizeSeverity } from '../src/review';
import { ReviewResult } from '../src/types';

const GIT_DIFF = `diff --git a/src/app.js b/src/app.js
index 1111111..2222222 100644
--- a/src/app.js
+++ b/src/app.js
@@ -1,5 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = a + b;
 function f() {
--- this line starts with dashes but is a deletion
   return a;
@@ -20,2 +20,3 @@ function g() {
 x();
+y();
 z();
\\ No newline at end of file
diff --git a/new file.txt b/new file.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new file.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/a.txt b/b.txt
similarity index 100%
rename from a.txt
rename to b.txt
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;

test('parseUnifiedDiff handles modified, added, deleted, renamed and binary files', () => {
  const files = parseUnifiedDiff(GIT_DIFF);
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.binary]),
    [
      ['src/app.js', 'modified', false],
      ['new file.txt', 'added', false],
      ['old.txt', 'deleted', false],
      ['b.txt', 'renamed', false],
      ['img.png', 'modified', true],
    ],
  );
  const app = files[0];
  assert.equal(app.hunks.length, 2);
  const h0 = app.hunks[0];
  assert.deepEqual(
    h0.lines.map((l) => [l.kind, l.newLine ?? null]),
    [
      ['ctx', 1],
      ['del', null],
      ['add', 2],
      ['add', 3],
      ['ctx', 4],
      ['del', null],
      ['ctx', 5],
    ],
  );
  assert.equal(h0.lines[5].text, '-- this line starts with dashes but is a deletion');
  assert.deepEqual(
    app.hunks[1].lines.map((l) => l.newLine),
    [20, 21, 22],
  );
  assert.equal(files[3].oldPath, 'a.txt');
});

test('commentable lines and annotation', () => {
  const [app] = parseUnifiedDiff(GIT_DIFF);
  const c = commentableLines(app);
  assert.deepEqual([...c.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5, 20, 21, 22]);
  assert.equal(c.get(21), 1);
  const text = annotateFile(app);
  assert.match(text, /=== File: src\/app\.js \(modified\) ===/);
  assert.match(text, /\n {3}3 \+ const c = a \+ b;/);
  assert.match(text, /\n {4} - const b = 2;/);
});

test('parsePatchHunks (GitHub files API patch)', () => {
  const hunks = parsePatchHunks('@@ -10,3 +10,4 @@ class X\n a\n-b\n+c\n+d\n e');
  assert.equal(hunks.length, 1);
  assert.deepEqual(
    hunks[0].lines.map((l) => [l.kind, l.newLine ?? null]),
    [
      ['ctx', 10],
      ['del', null],
      ['add', 11],
      ['add', 12],
      ['ctx', 13],
    ],
  );
});

test('chunkDiff packs small files together and splits big ones with headers', () => {
  const small = [fileDiffFromContent('a.ts', 'x\n'), fileDiffFromContent('b.ts', 'y\n')];
  const one = chunkDiff(small, 10000);
  assert.equal(one.length, 1);
  assert.equal(one[0].files.length, 2);

  const big = fileDiffFromContent('big.ts', Array.from({ length: 500 }, (_, i) => `line number ${i + 1} with some text`).join('\n'));
  const chunks = chunkDiff([big, ...small], 3000);
  assert.ok(chunks.length > 5);
  for (const ch of chunks) {
    assert.ok(ch.text.length <= 3000, `chunk too large: ${ch.text.length}`);
    assert.match(ch.text, /^=== File: /);
  }
  assert.match(chunks[1].text, /continued/);
  // Every line number survives chunking exactly once.
  const nums = chunks
    .flatMap((c) => c.text.split('\n'))
    .map((l) => /^\s*(\d+) \+ line number/.exec(l)?.[1])
    .filter(Boolean);
  assert.equal(nums.length, 500);
});

test('globs', () => {
  const ex = makeExcluder(['**/package-lock.json', '*.min.js', 'dist/**', '**/*.{png,jpg}']);
  assert.ok(ex('package-lock.json'));
  assert.ok(ex('web/package-lock.json'));
  assert.ok(ex('assets/app.min.js'));
  assert.ok(ex('dist/x/y.js'));
  assert.ok(ex('a/b.png'));
  assert.ok(!ex('src/dist.js'));
  assert.ok(!ex('src/app.js'));
});

test('parseModelOutput: plain, fenced, thinking, chatter, trailing commas, truncated', () => {
  const obj = { summary: 'ok', findings: [{ file: 'a', line: 1, severity: 'major', title: 't', body: 'b' }] };
  assert.equal(parseModelOutput(JSON.stringify(obj)).findings.length, 1);
  assert.equal(parseModelOutput('```json\n' + JSON.stringify(obj) + '\n```').summary, 'ok');
  assert.equal(parseModelOutput('<think>{"nope": 1}</think>\n' + JSON.stringify(obj)).summary, 'ok');
  assert.equal(parseModelOutput('Here is my review:\n' + JSON.stringify(obj) + '\nHope this helps!').findings.length, 1);
  assert.equal(parseModelOutput('{"summary":"s","findings":[{"title":"x","body":"y",},]}').findings.length, 1);
  const truncated = '{"summary": "partial", "findings": [{"file":"a","line":1,"title":"one","body":"b"}, {"file":"a","line":2,"title":"two","bo';
  const p = parseModelOutput(truncated);
  assert.ok(p.ok && p.partial);
  assert.equal(p.summary, 'partial');
  assert.equal(p.findings.length, 1);
  assert.equal(parseModelOutput('I cannot help').ok, false);
  assert.equal(parseModelOutput('[{"title":"x","body":"y"}]').findings.length, 1);
  assert.equal(stripThinking('reasoning text</think>{"a":1}'), '{"a":1}');
});

test('normalizeFindings maps files, severities and snaps lines', () => {
  const files = parseUnifiedDiff(GIT_DIFF);
  const out = normalizeFindings(
    [
      { file: 'src/app.js', line: 3, severity: 'HIGH', title: 'exact', body: 'b' },
      { file: './app.js', line: '2', endLine: 3, severity: 'critical', title: 'suffix + range', body: 'b' },
      { file: 'b/src/app.js', line: 7, severity: 'minor', title: 'snapped', body: 'b' },
      { file: 'src/app.js', line: 100, severity: 'nit', title: 'far away', body: 'b' },
      { file: 'nowhere.js', line: 1, severity: 'major', title: 'hallucinated file', body: 'b' },
      { path: '=== File: new file.txt (added) ===', line: 2, comment: 'only a body. More text' },
    ],
    files,
  );
  assert.deepEqual(
    out.map((f) => [f.file, f.line, f.endLine, f.severity, f.inline, !!f.lineAdjusted]),
    [
      ['src/app.js', 3, undefined, 'major', true, false],
      ['src/app.js', 2, 3, 'critical', true, false],
      ['src/app.js', 5, undefined, 'minor', true, true],
      ['src/app.js', 100, undefined, 'nit', false, false],
      ['nowhere.js', 1, undefined, 'major', false, false],
      ['new file.txt', 2, undefined, 'minor', true, false],
    ],
  );
  assert.equal(out[5].title, 'only a body.');
});

test('mapLines drops ranges that cross hunks', () => {
  const [app] = parseUnifiedDiff(GIT_DIFF);
  assert.deepEqual(mapLines(app, 3, 21), { line: 3, endLine: undefined, inline: true, adjusted: false });
});

test('helpers', () => {
  assert.equal(normalizeSeverity('Warning'), 'minor');
  assert.equal(normalizeSeverity('???'), 'minor');
  assert.equal(cleanPath('a/src/x.ts'), 'src/x.ts');
  assert.equal(webHostFromApiUrl('https://api.github.com'), 'github.com');
  assert.equal(webHostFromApiUrl('https://ghe.corp.com/api/v3'), 'ghe.corp.com');
  for (const u of [
    'git@github.com:Owner/my.repo.git',
    'https://github.com/Owner/my.repo',
    'https://user@github.com/Owner/my.repo.git',
    'ssh://git@github.com/Owner/my.repo.git',
  ]) {
    assert.deepEqual(parseRemoteUrl(u, 'github.com'), { owner: 'Owner', repo: 'my.repo' }, u);
  }
  assert.equal(parseRemoteUrl('git@gitlab.com:o/r.git', 'github.com'), undefined);
  const def = { owner: 'o', repo: 'r' };
  assert.deepEqual(parsePrReference('42', 'github.com', def), { repo: def, number: 42 });
  assert.deepEqual(parsePrReference('#42', 'github.com', def), { repo: def, number: 42 });
  assert.deepEqual(parsePrReference('x/y#7', 'github.com'), { repo: { owner: 'x', repo: 'y' }, number: 7 });
  assert.deepEqual(parsePrReference('https://github.com/x/y/pull/9/files', 'github.com'), { repo: { owner: 'x', repo: 'y' }, number: 9 });
  assert.equal(parsePrReference('42', 'github.com'), undefined);
});

test('buildReviewPayload', () => {
  const result: ReviewResult = {
    summary: 'Looks mostly fine.',
    model: 'qwen',
    reviewedFiles: ['a.ts'],
    skippedFiles: [{ path: 'img.png', reason: 'binary' }],
    chunkCount: 1,
    errors: [],
    durationMs: 1,
    findings: [
      { file: 'a.ts', line: 3, endLine: 5, severity: 'major', category: 'bug', title: 'Bug', body: 'Explain', suggestion: 'fixed()', inline: true },
      { file: 'a.ts', line: 9, severity: 'minor', title: 'Snapped', body: 'x', suggestion: 'y', inline: true, lineAdjusted: true },
      { file: 'b.ts', line: 1, severity: 'nit', title: 'Elsewhere <b>', body: 'z', inline: false },
    ],
  };
  const p = buildReviewPayload(result, { headSha: 'abc' }, { event: 'REQUEST_CHANGES_IF_BLOCKING', suggestionBlocks: true });
  assert.equal(p.event, 'REQUEST_CHANGES');
  assert.equal(p.commit_id, 'abc');
  assert.equal(p.comments.length, 2);
  assert.deepEqual([p.comments[0].start_line, p.comments[0].line, p.comments[0].side], [3, 5, 'RIGHT']);
  assert.match(p.comments[0].body, /```suggestion\nfixed\(\)\n```/);
  assert.doesNotMatch(p.comments[1].body, /```suggestion/); // adjusted line => plain block
  assert.match(p.body, /Elsewhere &lt;b&gt;/);
  assert.match(p.body, /img\.png/);

  const pending = buildReviewPayload(result, { headSha: 'abc' }, { event: 'PENDING', suggestionBlocks: false });
  assert.equal(pending.event, undefined);
  const flat = buildReviewPayload(result, { headSha: 'abc' }, { event: 'COMMENT', suggestionBlocks: false, forceAllInBody: true });
  assert.equal(flat.comments.length, 0);
  assert.match(flat.body, /### Findings/);
  assert.match(formatCommentBody(result.findings[0], false), /Suggested change:\n```\nfixed\(\)\n```/);
});
