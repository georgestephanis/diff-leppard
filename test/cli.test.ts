import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadConfig, merge, parseJsonc } from '../src/config';
import { renderTerminal } from '../src/format';

test('merge handles prefixed and github.* keys, replaces extraBody wholesale', () => {
  const m = merge({ a: 1, extraBody: { x: 1 }, github: { apiUrl: 'u', reviewEvent: 'COMMENT' } } as Record<string, unknown>, {
    'diffLeppard.model': 'm',
    'github.reviewEvent': 'PENDING',
    extraBody: { y: 2 },
  });
  assert.deepEqual(m, { a: 1, model: 'm', extraBody: { y: 2 }, github: { apiUrl: 'u', reviewEvent: 'PENDING' } });
});

test('loadConfig precedence: user file < repo file < env < flags', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'diff-leppard-cfg-'));
  const user = path.join(dir, 'user.json');
  writeFileSync(user, '{\n // comment\n "baseUrl": "http://user/v1", "model": "user-model", "apiKey": "k", "concurrency": 3, // trailing comment\n}');
  const repo = { json: { model: 'repo-model', minimumSeverity: 'nit' }, source: 'repo' };
  const { settings, sources } = await loadConfig(repo, { concurrency: 5 }, { DIFF_LEPPARD_CONFIG: user, DIFF_LEPPARD_BASE_URL: 'http://env/v1', DIFF_LEPPARD_EXTRA_HEADERS: '{"X":"1"}' });
  assert.equal(sources.length, 2);
  assert.equal(settings.baseUrl, 'http://env/v1');
  assert.equal(settings.model, 'repo-model');
  assert.equal(settings.apiKey, 'k');
  assert.equal(settings.minimumSeverity, 'nit');
  assert.equal(settings.concurrency, 5);
  assert.deepEqual(settings.extraHeaders, { X: '1' });
});

test('repo config cannot redirect requests or set credentials, however the keys are spelled', async () => {
  const env = { DIFF_LEPPARD_CONFIG: '/nonexistent' };
  const hostile = {
    json: {
      baseUrl: 'https://evil/v1',
      'diffLeppard.apiKey': 'leak',
      'github.apiUrl': 'https://evil',
      github: { reviewEvent: 'PENDING' },
      extraHeaders: { X: 'y' },
      extraBody: { messages: [] },
      excludeGlobs: ['vendor/**'],
    },
    source: 'repo',
  };
  const { settings, warnings } = await loadConfig(hostile, {}, env);
  assert.equal(settings.baseUrl, 'http://localhost:8000/v1');
  assert.equal(settings.apiKey, '');
  assert.equal(settings.github.apiUrl, 'https://api.github.com');
  assert.equal(settings.github.reviewEvent, 'COMMENT');
  assert.deepEqual(settings.extraHeaders, {});
  assert.deepEqual(settings.extraBody, {});
  assert.deepEqual(settings.excludeGlobs, ['vendor/**']);
  assert.match(warnings[0], /ignoring baseUrl, apiKey, github\.apiUrl, github\.reviewEvent, extraHeaders, extraBody/);
});

test('settings are validated; every key is available from the environment', async () => {
  const env = { DIFF_LEPPARD_CONFIG: '/nonexistent' };
  await assert.rejects(loadConfig(undefined, {}, { ...env, DIFF_LEPPARD_CONCURRENCY: 'abc' }), /concurrency must be a whole number/);
  await assert.rejects(loadConfig(undefined, { maxChunkChars: Number('x') }, env), /maxChunkChars/);
  await assert.rejects(loadConfig(undefined, {}, { ...env, DIFF_LEPPARD_STREAM: 'maybe' }), /DIFF_LEPPARD_STREAM must be true or false/);
  await assert.rejects(loadConfig(undefined, { baseUrl: 'file:///etc' }, env), /baseUrl must be an http/);
  const { settings } = await loadConfig(
    undefined,
    {},
    {
      ...env,
      DIFF_LEPPARD_STREAM: 'false',
      DIFF_LEPPARD_TEMPERATURE: '0',
      DIFF_LEPPARD_CONTEXT_LINES: '10',
      DIFF_LEPPARD_EXCLUDE_GLOBS: 'a/**, b/**',
      DIFF_LEPPARD_GITHUB_ATTRIBUTION: 'false',
      DIFF_LEPPARD_MIN_SEVERITY: 'major',
      DIFF_LEPPARD_TIMEOUT_SECONDS: '30',
    },
  );
  assert.equal(settings.stream, false);
  assert.equal(settings.temperature, 0);
  assert.equal(settings.contextLines, 10);
  assert.deepEqual(settings.excludeGlobs, ['a/**', 'b/**']);
  assert.equal(settings.github.attribution, false);
  assert.equal(settings.minimumSeverity, 'major');
  assert.equal(settings.requestTimeoutSeconds, 30);
});

test('parseJsonc leaves string contents alone', () => {
  assert.deepEqual(parseJsonc('{"a": "f(x, ) // not a comment", /* c */ "b": [1, 2,],}'), { a: 'f(x, ) // not a comment', b: [1, 2] });
  assert.deepEqual(parseJsonc('{ "url": "http://example.com/*x*/", "q": "say \\"hi\\" // there" } // done'), { url: 'http://example.com/*x*/', q: 'say "hi" // there' });
});

test('renderTerminal without color', () => {
  const out = renderTerminal(
    {
      summary: 'S',
      model: 'm',
      reviewedFiles: ['a.js'],
      skippedFiles: [],
      chunkCount: 1,
      errors: [],
      durationMs: 1000,
      findings: [{ file: 'a.js', line: 3, endLine: 4, severity: 'major', category: 'bug', title: 'T', body: 'B', suggestion: 'x()', inline: true }],
    },
    { color: false, title: 'Title' },
  );
  assert.match(out, /MAJOR {4}a\.js:3-4 \[bug\]/);
  assert.match(out, /│ x\(\)/);
  assert.doesNotMatch(out, /\x1b\[/);
});

test('CLI reviews local changes against a mock server and honours --fail-on', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'diff-leppard-cli-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
  git('init', '-q');
  writeFileSync(path.join(repo, 'a.js'), 'x\n');
  git('add', '.');
  git('commit', '-qm', 'i');
  writeFileSync(path.join(repo, 'a.js'), 'x\ny\n');
  git('config', 'diff.mnemonicPrefix', 'true'); // must not change reported paths
  symlinkSync('/etc/hosts', path.join(repo, 'link'));

  const server = spawn(process.execPath, [path.join(__dirname, '../../test/fixtures/mock-openai.js'), '8766']);
  await new Promise((r) => server.stdout.once('data', r));
  try {
    // Exercise the shipped artifact (dist/), not just the test build.
    const cli = path.join(__dirname, '../../dist/cli.js');
    const env = { ...process.env, DIFF_LEPPARD_CONFIG: '/nonexistent', DIFF_LEPPARD_BASE_URL: 'http://127.0.0.1:8766/v1' };
    const run = (args: string[], extraEnv: Record<string, string> = {}) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        const p = spawn(process.execPath, [cli, ...args], { cwd: repo, env: { ...env, ...extraEnv } });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.on('close', (code) => resolve({ code: code ?? -1, out }));
      });
    const json = await run(['local', '-q', '-f', 'json']);
    assert.equal(json.code, 0);
    const r = JSON.parse(json.out);
    assert.equal(r.model, 'mock-model');
    assert.deepEqual(r.findings.map((f: { file: string; line: number }) => [f.file, f.line]), [['a.js', 2]]);
    assert.ok(r.skippedFiles.some((x: { path: string; reason: string }) => x.path === 'link' && x.reason === 'symlink'));
    assert.equal((await run(['local', '-q', '--fail-on', 'minor'])).code, 1);
    assert.equal((await run(['local', '-q', '--fail-on', 'major'])).code, 0);
    const md = await run(['local', '-q', '-f', 'markdown']);
    assert.match(md.out, /^# Review of uncommitted changes/);
    assert.equal((await run(['local', '-q', '--concurrency', 'abc'])).code, 2);
    const outDir = mkdtempSync(path.join(tmpdir(), 'diff-leppard-out-'));
    const outs = ['r.json', 'r.sarif', 'r.rdjson', 'r.md'].map((n) => path.join(outDir, n));
    assert.equal((await run(['local', '-q', '-f', 'sarif', ...outs.flatMap((f) => ['-o', f])])).code, 0);
    assert.equal(JSON.parse(readFileSync(outs[0], 'utf8')).findings.length, 1);
    assert.equal(JSON.parse(readFileSync(outs[1], 'utf8')).version, '2.1.0');
    assert.equal(JSON.parse(readFileSync(outs[2], 'utf8')).source.name, 'diff-leppard');
    assert.match(readFileSync(outs[3], 'utf8'), /^# Review of/);

    // Commit ranges, merge-base mode and the pre-commit hook entry point.
    const files = (out: string) => JSON.parse(out).findings.map((f: { file: string; line: number }) => `${f.file}:${f.line}`).sort();
    git('add', 'a.js');
    git('commit', '-qm', 'second');
    const [first, second] = ['HEAD~1', 'HEAD'].map((r) => execFileSync('git', ['rev-parse', r], { cwd: repo }).toString().trim());
    assert.deepEqual(files((await run(['local', '-q', '-f', 'json', '--range', 'HEAD~1..HEAD'])).out), ['a.js:2']);
    writeFileSync(path.join(repo, 'b.js'), 'one\n');
    git('add', 'b.js');
    assert.deepEqual(files((await run(['hook', '-f', 'json'])).out), ['b.js:1'], 'hook at pre-commit: staged changes');
    assert.deepEqual(
      files((await run(['hook', '-f', 'json'], { PRE_COMMIT_FROM_REF: first, PRE_COMMIT_TO_REF: second })).out),
      ['a.js:2'],
      'hook at pre-push: the pushed commits',
    );
    assert.deepEqual(files((await run(['local', '-q', '-f', 'json', '--base', 'HEAD~1'])).out), ['a.js:2', 'b.js:1'], 'base: committed + staged');
    assert.equal((await run(['hook', '--fail-on', 'minor'])).code, 1, 'hook fails the commit on findings');
    assert.equal((await run(['local', '--staged', '--base', 'HEAD'])).code, 2, 'conflicting modes');
    assert.equal((await run(['local', '--range', 'nope..HEAD'])).code, 2, 'unknown ref');
  } finally {
    server.kill();
  }
});
