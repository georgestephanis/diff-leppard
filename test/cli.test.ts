import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadConfig, merge } from '../src/config';
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
  writeFileSync(user, '{\n // comment\n "baseUrl": "http://user/v1", "model": "user-model", "apiKey": "k", "concurrency": 3,\n}');
  writeFileSync(path.join(dir, '.diff-leppard.json'), '{"model": "repo-model", "minimumSeverity": "nit"}');
  const { settings, sources } = await loadConfig(dir, { concurrency: 5 }, { DIFF_LEPPARD_CONFIG: user, DIFF_LEPPARD_BASE_URL: 'http://env/v1', DIFF_LEPPARD_EXTRA_HEADERS: '{"X":"1"}' });
  assert.equal(sources.length, 2);
  assert.equal(settings.baseUrl, 'http://env/v1');
  assert.equal(settings.model, 'repo-model');
  assert.equal(settings.apiKey, 'k');
  assert.equal(settings.minimumSeverity, 'nit');
  assert.equal(settings.concurrency, 5);
  assert.deepEqual(settings.extraHeaders, { X: '1' });

  writeFileSync(path.join(dir, '.diff-leppard.json'), '{"apiKey": "leak"}');
  await assert.rejects(loadConfig(dir, {}, { DIFF_LEPPARD_CONFIG: user }), /must not contain apiKey/);
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

  const server = spawn(process.execPath, [path.join(__dirname, '../../test/fixtures/mock-openai.js'), '8766']);
  await new Promise((r) => server.stdout.once('data', r));
  try {
    const cli = path.join(__dirname, '../src/cli.js');
    const env = { ...process.env, DIFF_LEPPARD_CONFIG: '/nonexistent', DIFF_LEPPARD_BASE_URL: 'http://127.0.0.1:8766/v1' };
    const run = (args: string[]) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        const p = spawn(process.execPath, [cli, ...args], { cwd: repo, env });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.on('close', (code) => resolve({ code: code ?? -1, out }));
      });
    const json = await run(['local', '-q', '-f', 'json']);
    assert.equal(json.code, 0);
    const r = JSON.parse(json.out);
    assert.equal(r.model, 'mock-model');
    assert.deepEqual(r.findings.map((f: { file: string; line: number }) => [f.file, f.line]), [['a.js', 2]]);
    assert.equal((await run(['local', '-q', '--fail-on', 'minor'])).code, 1);
    assert.equal((await run(['local', '-q', '--fail-on', 'major'])).code, 0);
    const md = await run(['local', '-q', '-f', 'markdown']);
    assert.match(md.out, /^# Review of uncommitted changes/);
  } finally {
    server.kill();
  }
});
