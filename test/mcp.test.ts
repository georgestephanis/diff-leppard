import assert from 'node:assert/strict';
import { ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

/** A minimal MCP client over a child's stdio. */
class Client {
  private buf = '';
  readonly messages: any[] = [];
  private waiters: { match: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  private nextId = 1;

  constructor(readonly proc: ChildProcessWithoutNullStreams) {
    proc.stdout.on('data', (d) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        const msg = JSON.parse(line); // every stdout line must be a JSON-RPC message
        this.messages.push(msg);
        this.waiters = this.waiters.filter((w) => (w.match(msg) ? (w.resolve(msg), false) : true));
      }
    });
  }

  send(msg: object): void {
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  wait(match: (m: any) => boolean, ms = 10000): Promise<any> {
    const found = this.messages.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for MCP message')), ms);
      this.waiters.push({ match, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  async request(method: string, params: object = {}): Promise<any> {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return this.wait((m) => m.id === id && ('result' in m || 'error' in m));
  }

  async call(name: string, args: object = {}): Promise<any> {
    return (await this.request('tools/call', { name, arguments: args })).result;
  }
}

test('MCP server: handshake, tools, reviews, input checks, cancellation', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'diff-leppard-mcp-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
  git('init', '-q');
  writeFileSync(path.join(repo, 'a.js'), 'x\n');
  git('add', '.');
  git('commit', '-qm', 'i');
  writeFileSync(path.join(repo, 'a.js'), 'x\ny\n');

  const server = spawn(process.execPath, [path.join(__dirname, '../../test/fixtures/mock-openai.js'), '8767']);
  await new Promise((r) => server.stdout.once('data', r));
  const proc = spawn(process.execPath, [path.join(__dirname, '../../dist/cli.js'), 'mcp'], {
    cwd: repo,
    env: { ...process.env, DIFF_LEPPARD_CONFIG: '/nonexistent', DIFF_LEPPARD_BASE_URL: 'http://127.0.0.1:8767/v1' },
  });
  const c = new Client(proc);
  try {
    const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'diff-leppard');
    assert.ok(init.result.capabilities.tools);
    assert.match(init.result.instructions, /verify each finding/);
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const old = await c.request('initialize', { protocolVersion: '1999-01-01' });
    assert.equal(old.result.protocolVersion, '2025-06-18', 'unknown version → our latest');

    assert.deepEqual((await c.request('ping')).result, {});
    const tools = (await c.request('tools/list')).result.tools.map((t: { name: string }) => t.name);
    assert.deepEqual(tools, ['review_local_changes', 'review_pull_request', 'check_model_server']);

    // Review the uncommitted change.
    const r = await c.call('review_local_changes');
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.structuredContent.findings.map((f: { file: string; line: number }) => [f.file, f.line]), [['a.js', 2]]);
    assert.equal(r.structuredContent.model, 'mock-model');
    assert.deepEqual(JSON.parse(r.content[0].text).findings, r.structuredContent.findings);

    // min_severity filters; staged with nothing staged is "nothing to review".
    assert.equal((await c.call('review_local_changes', { min_severity: 'major' })).structuredContent.findings.length, 0);
    assert.match((await c.call('review_local_changes', { staged: true })).content[0].text, /nothing to review/);

    // Bad input is a tool error, not a protocol error. Refs can't smuggle git options.
    const evil = await c.call('review_local_changes', { base: '--output=/tmp/pwned' });
    assert.equal(evil.isError, true);
    assert.match(evil.content[0].text, /Invalid git ref/);
    assert.equal((await c.call('review_local_changes', { range: 'HEAD...--all' })).isError, true);
    assert.match((await c.call('review_local_changes', { path: tmpdir() })).content[0].text, /not inside a git repository/);
    assert.match((await c.call('review_local_changes', { min_severity: 'huge' })).content[0].text, /min_severity must be one of/);
    assert.match((await c.call('review_pull_request', { pr: 'not a pr' })).content[0].text, /Can't tell which PR/);
    assert.equal((await c.request('tools/call', { name: 'nope' })).error.code, -32602);
    assert.equal((await c.request('resources/list')).error.code, -32601);

    assert.match((await c.call('check_model_server')).content[0].text, /^mock-model at .* replied in/);

    // Cancelled before it runs: no reply for it, and the server keeps working.
    c.send({ jsonrpc: '2.0', id: 'slow', method: 'tools/call', params: { name: 'review_local_changes', arguments: {} } });
    c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow', reason: 'test' } });
    assert.deepEqual((await c.request('ping')).result, {});
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!c.messages.some((m) => m.id === 'slow'), 'no response to a cancelled request');

    // Closing stdin shuts it down cleanly.
    proc.stdin.end();
    const code = await new Promise((r) => proc.on('close', r));
    assert.equal(code, 0);
  } finally {
    proc.kill();
    server.kill();
  }
});
