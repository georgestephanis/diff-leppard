import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { parseInterval, repoMatches, watchQueries } from '../src/watch';
import { defaultSettings } from '../src/config';

// ---------------------------------------------------------------------------
// Mock GitHub API + mock model server
// ---------------------------------------------------------------------------

interface MockPr {
  owner: string;
  repo: string;
  number: number;
  head: string;
  draft?: boolean;
  state?: string;
  mine?: boolean; // authored by @me
  requested?: boolean; // review requested from @me
}

let gh: http.Server;
let ghUrl = '';
let llm: ChildProcess;
const LLM_PORT = 8768;
let prs: MockPr[] = [];
let posted: { key: string; body: Record<string, unknown> }[] = [];
let searches: string[] = [];
const pendingConflict = new Set<string>();

const key = (p: MockPr) => `${p.owner}/${p.repo}#${p.number}`;

before(async () => {
  gh = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url!, ghUrl);
      const json = (status: number, data: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(data));
      };
      if (url.pathname === '/search/issues') {
        const q = url.searchParams.get('q') ?? '';
        searches.push(q);
        const hits = prs.filter(
          (p) =>
            (p.state ?? 'open') === 'open' &&
            (!q.includes('draft:false') || !p.draft) &&
            ((q.includes('review-requested:@me') && p.requested) || (q.includes('author:@me') && p.mine)),
        );
        return json(200, {
          items: hits.map((p) => ({
            number: p.number,
            title: `PR ${p.number}`,
            html_url: `https://example.test/${p.owner}/${p.repo}/pull/${p.number}`,
            repository_url: `${ghUrl}/repos/${p.owner}/${p.repo}`,
            draft: !!p.draft,
            user: { login: p.mine ? 'me' : 'someone' },
          })),
        });
      }
      const m = /^\/repos\/([^/]+)\/([^/]+)\/(pulls|contents)\/(\d+)?(\/files|\/reviews)?/.exec(url.pathname);
      if (!m) return json(404, { message: 'Not Found' });
      const [, owner, repo, kind, num, sub] = m;
      if (kind === 'contents') return json(404, { message: 'Not Found' });
      const pr = prs.find((p) => p.owner === owner && p.repo === repo && p.number === Number(num));
      if (!pr) return json(404, { message: 'Not Found' });
      if (!sub) {
        return json(200, {
          number: pr.number,
          title: `PR ${pr.number}`,
          body: '',
          head: { sha: pr.head, ref: 'feature' },
          base: { sha: 'base000', ref: 'main' },
          html_url: `https://example.test/${owner}/${repo}/pull/${pr.number}`,
          user: { login: pr.mine ? 'me' : 'someone' },
          state: pr.state ?? 'open',
          draft: !!pr.draft,
        });
      }
      if (sub === '/files') return json(200, [{ filename: 'a.js', status: 'modified', changes: 1, patch: '@@ -1,1 +1,2 @@\n x\n+y' }]);
      if (sub === '/reviews' && req.method === 'POST') {
        if (pendingConflict.has(key(pr))) {
          return json(422, { message: 'Unprocessable Entity', errors: ['User can only have one pending review per pull request'] });
        }
        posted.push({ key: key(pr), body: JSON.parse(body) });
        return json(200, { id: posted.length, html_url: `https://example.test/${owner}/${repo}/pull/${pr.number}#review-${posted.length}`, state: 'PENDING' });
      }
      json(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((r) => gh.listen(0, '127.0.0.1', r));
  ghUrl = `http://127.0.0.1:${(gh.address() as AddressInfo).port}`;
  llm = spawn(process.execPath, [path.join(__dirname, '../../test/fixtures/mock-openai.js'), String(LLM_PORT)]);
  await new Promise((r) => llm.stdout!.once('data', r));
});
after(() => {
  gh.close();
  llm.kill();
});

function reset(list: MockPr[]) {
  prs = list;
  posted = [];
  searches = [];
  pendingConflict.clear();
}

function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; err: string; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, '../../dist/cli.js'), ...args], {
      env: {
        ...process.env,
        DIFF_LEPPARD_CONFIG: '/nonexistent',
        DIFF_LEPPARD_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`,
        DIFF_LEPPARD_GITHUB_API_URL: ghUrl,
        GH_ENTERPRISE_TOKEN: 'test-token', // the mock isn't github.com, so the enterprise token is used
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
        ...env,
      },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code: code ?? -1, err, out }));
  });
}

const tmpState = () => path.join(mkdtempSync(path.join(tmpdir(), 'diff-leppard-watch-')), 'state.json');

// ---------------------------------------------------------------------------

test('watch helpers', () => {
  assert.equal(parseInterval('5m'), 300_000);
  assert.equal(parseInterval('90s'), 90_000);
  assert.equal(parseInterval('1h'), 3_600_000);
  assert.equal(parseInterval('10'), 600_000);
  assert.throws(() => parseInterval('5s'), /at least 30s/);
  assert.throws(() => parseInterval('soon'), /30s, 5m or 1h/);
  const w = defaultSettings().watch;
  assert.deepEqual(watchQueries(w), ['is:pr is:open archived:false draft:false user-review-requested:@me']);
  assert.deepEqual(watchQueries({ ...w, reviewRequests: 'team', ownPullRequests: true, skipDrafts: false, query: 'org:acme label:x' }), [
    'is:pr is:open archived:false review-requested:@me',
    'is:pr is:open archived:false author:@me',
    'is:pr is:open archived:false org:acme label:x',
  ]);
  assert.ok(repoMatches({ owner: 'Acme', repo: 'web' }, ['acme/*']));
  assert.ok(repoMatches({ owner: 'acme', repo: 'web' }, ['acme/web']));
  assert.ok(!repoMatches({ owner: 'acme', repo: 'web' }, ['acme/api', 'other/*']));
});

test('watch: dry run, draft reviews once per commit, re-review on push, filters, limits', async () => {
  reset([
    { owner: 'o', repo: 'r', number: 1, head: 'aaa1111', requested: true },
    { owner: 'o', repo: 'r', number: 2, head: 'bbb2222', mine: true },
    { owner: 'x', repo: 'y', number: 3, head: 'ccc3333', requested: true },
    { owner: 'o', repo: 'r', number: 4, head: 'ddd4444', requested: true, draft: true },
  ]);
  const state = tmpState();

  let r = await cli(['watch', '--dry-run', '--state', state]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /would review o\/r#1/);
  assert.match(r.err, /would review x\/y#3/);
  assert.doesNotMatch(r.err, /#2|#4/, 'own PRs off by default; drafts skipped');
  assert.equal(posted.length, 0);
  assert.ok(searches.every((q) => q.includes('user-review-requested:@me') && q.includes('draft:false')));

  r = await cli(['watch', '--once', '--state', state]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(posted.map((p) => p.key).sort(), ['o/r#1', 'x/y#3']);
  assert.ok(posted.every((p) => p.body.event === undefined), 'drafts (pending reviews) by default');
  assert.match(String(posted[0].body.body), /Diff Leppard/);
  const saved = JSON.parse(readFileSync(state, 'utf8'));
  assert.equal(saved.reviewed['o/r#1'].sha, 'aaa1111');
  assert.ok(!existsSync(`${state}.lock`), 'lock released');

  r = await cli(['watch', '--once', '--state', state]);
  assert.equal(posted.length, 2, 'nothing new: each PR reviewed once');

  prs[0].head = 'aaa9999';
  r = await cli(['watch', '--once', '--state', state]);
  assert.equal(posted.length, 2, 'new commits are not re-reviewed by default');
  r = await cli(['watch', '--once', '--state', state], { DIFF_LEPPARD_WATCH_REREVIEW_ON_PUSH: 'true' });
  assert.deepEqual(posted.slice(2).map((p) => p.key), ['o/r#1'], 're-reviewed after a push when enabled');

  // Own PRs, exclusions, a per-run cap, and comment reviews.
  posted = [];
  const fresh = tmpState();
  r = await cli(['watch', '--once', '--post', '--state', fresh], {
    DIFF_LEPPARD_WATCH_OWN_PULL_REQUESTS: 'true',
    DIFF_LEPPARD_WATCH_EXCLUDE_REPOS: 'x/*',
    DIFF_LEPPARD_WATCH_MAX_PER_RUN: '1',
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.event, 'COMMENT');
  assert.match(r.err, /1 left for next time/);
  r = await cli(['watch', '--once', '--post', '--state', fresh], {
    DIFF_LEPPARD_WATCH_OWN_PULL_REQUESTS: 'true',
    DIFF_LEPPARD_WATCH_EXCLUDE_REPOS: 'x/*',
    DIFF_LEPPARD_WATCH_MAX_PER_RUN: '1',
  });
  assert.deepEqual(posted.map((p) => p.key).sort(), ['o/r#1', 'o/r#2'], 'the deferred PR is picked up next time; x/y excluded');
});

test('watch: an existing pending review is skipped, not retried; a running watch blocks a second one', async () => {
  reset([{ owner: 'o', repo: 'r', number: 1, head: 'aaa1111', requested: true }]);
  pendingConflict.add('o/r#1');
  const state = tmpState();
  let r = await cli(['watch', '--once', '--state', state]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /already have a pending review/);
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).reviewed['o/r#1'].skipped, 'you already have a pending review on this PR');
  pendingConflict.clear();
  r = await cli(['watch', '--once', '--state', state]);
  assert.equal(posted.length, 0, 'not retried for the same commit');

  const locked = tmpState();
  writeFileSync(`${locked}.lock`, String(process.pid)); // a live process holds the lock
  r = await cli(['watch', '--once', '--state', locked]);
  assert.equal(r.code, 0);
  assert.match(r.err, /already running/);
  writeFileSync(`${locked}.lock`, '999999'); // stale lock from a dead process
  r = await cli(['watch', '--once', '--state', locked]);
  assert.equal(r.code, 0, r.err);
  assert.equal(posted.length, 1, 'stale lock is taken over');
});

test('pr command reviews and posts through the shared flow', async () => {
  reset([{ owner: 'o', repo: 'r', number: 7, head: 'eee5555' }]);
  const r = await cli(['pr', 'o/r#7', '--post', '--no-prompt', '-q', '-f', 'json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).findings.length, 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.event, 'COMMENT');
  assert.equal(posted[0].body.commit_id, 'eee5555');
});
