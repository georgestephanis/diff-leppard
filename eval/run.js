#!/usr/bin/env node
/*
 * Review-quality evaluation: run Diff Leppard over small cases with known answers and score recall and
 * false positives. See eval/README.md.
 *
 *   npm run eval -- [--label name] [--cases a,b] [--config file.json] [--keep] [-- <extra diff-leppard args>]
 *
 * Each case in eval/cases/<name>/ has before/ and after/ trees, a description.md (first line = title) and
 * expected.json. The runner commits both trees into a throwaway git repo and reviews the range.
 */
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');

function parse(argv) {
  const o = { label: 'run', cases: undefined, config: undefined, keep: false, extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      o.extra = argv.slice(i + 1);
      break;
    } else if (a === '--label') o.label = argv[++i];
    else if (a === '--cases') o.cases = argv[++i].split(',');
    else if (a === '--config') o.config = path.resolve(argv[++i]);
    else if (a === '--keep') o.keep = true;
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function copyTree(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyTree(s, d);
    } else fs.copyFileSync(s, d);
  }
}

function makeRepo(caseDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-eval-'));
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const git = (...a) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'eval@example.com');
  git('config', 'user.name', 'eval');
  copyTree(path.join(caseDir, 'before'), dir);
  git('add', '-A');
  git('commit', '-q', '-m', 'before');
  const from = git('rev-parse', 'HEAD');
  for (const e of fs.readdirSync(dir)) if (e !== '.git') fs.rmSync(path.join(dir, e), { recursive: true });
  copyTree(path.join(caseDir, 'after'), dir);
  git('add', '-A');
  git('commit', '-q', '-m', 'after');
  return { dir, range: `${from}..${git('rev-parse', 'HEAD')}` };
}

/** Loose on purpose: file suffix, line within ±15 of the window, any keyword in title or body. */
function matches(f, e, slack = 15) {
  if (!(f.file || '').endsWith(e.file)) return false;
  const ln = f.line || 0;
  if (ln < e.lines[0] - slack || ln > e.lines[1] + slack) return false;
  const text = `${f.title || ''} ${f.body || ''}`.toLowerCase();
  return e.keywords.some((k) => text.includes(k.toLowerCase()));
}

function main() {
  const o = parse(process.argv.slice(2));
  const casesDir = path.join(__dirname, 'cases');
  const names = fs.readdirSync(casesDir).filter((n) => fs.existsSync(path.join(casesDir, n, 'expected.json'))).filter((n) => !o.cases || o.cases.includes(n));
  const out = { label: o.label, date: new Date().toISOString().slice(0, 10), args: o.extra, model: undefined, cases: {}, total: {} };
  const tot = { expected: 0, found: 0, majorsExpected: 0, majorsFound: 0, traps: 0, trapsHit: 0, unmatched: 0, loudUnmatched: 0, seconds: 0 };
  for (const name of names) {
    const caseDir = path.join(casesDir, name);
    const spec = JSON.parse(fs.readFileSync(path.join(caseDir, 'expected.json'), 'utf8'));
    const { dir, range } = makeRepo(caseDir);
    const descFile = path.join(caseDir, 'description.md');
    const args = [CLI, 'local', '--range', range, '-C', dir, '-q', '-f', 'json'];
    if (fs.existsSync(descFile)) {
      const [title, ...body] = fs.readFileSync(descFile, 'utf8').trim().split('\n');
      const tmp = path.join(os.tmpdir(), `dl-eval-desc-${process.pid}-${name}.md`);
      fs.writeFileSync(tmp, body.join('\n').trim());
      args.push('--title', title.trim(), '--description', `@${tmp}`);
    }
    const env = { ...process.env };
    if (o.config) env.DIFF_LEPPARD_CONFIG = o.config;
    const t0 = Date.now();
    const p = spawnSync(process.execPath, [...args, ...o.extra], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const seconds = (Date.now() - t0) / 1000;
    if (o.keep) console.error(`${name}: kept ${dir}`);
    else fs.rmSync(dir, { recursive: true, force: true });
    let res;
    try {
      res = JSON.parse(p.stdout);
    } catch {
      console.error(`${name}: no JSON output (exit ${p.status})\n${(p.stderr || '').slice(-800)}`);
      out.cases[name] = { error: (p.stderr || '').slice(-800) };
      continue;
    }
    out.model ??= res.model;
    const fnd = res.findings || [];
    const found = Object.fromEntries(spec.expected.map((e) => [e.id, fnd.some((f) => matches(f, e))]));
    const traps = Object.fromEntries(spec.traps.map((t) => [t.id, fnd.some((f) => matches(f, t))]));
    const all = [...spec.expected, ...spec.traps];
    const unmatched = fnd.filter((f) => !all.some((e) => matches(f, e)));
    const loud = fnd.filter((f) => ['critical', 'major'].includes(f.severity) && !spec.expected.some((e) => matches(f, e)));
    const majors = spec.expected.filter((e) => e.severity === 'major');
    out.cases[name] = {
      found,
      traps,
      unmatched: unmatched.map((f) => `[${f.severity}] ${f.file}:${f.line ?? ''} ${f.title}`),
      rejected: (res.rejectedFindings || []).map((f) => `[${f.severity}] ${f.file}:${f.line ?? ''} ${f.title}`),
      findings: fnd.map((f) => ({ severity: f.severity, file: f.file, line: f.line, title: f.title })),
      seconds: Math.round(seconds),
    };
    tot.expected += spec.expected.length;
    tot.found += Object.values(found).filter(Boolean).length;
    tot.majorsExpected += majors.length;
    tot.majorsFound += majors.filter((e) => found[e.id]).length;
    tot.traps += spec.traps.length;
    tot.trapsHit += Object.values(traps).filter(Boolean).length;
    tot.unmatched += unmatched.length;
    tot.loudUnmatched += loud.length;
    tot.seconds += Math.round(seconds);
    console.log(
      `${name.padEnd(20)} found ${Object.values(found).filter(Boolean).length}/${spec.expected.length}  traps ${Object.values(traps).filter(Boolean).length}/${spec.traps.length}  other ${unmatched.length} (${loud.length} crit/major)  ${Math.round(seconds)}s`,
    );
  }
  out.total = tot;
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  const file = path.join(__dirname, 'results', `${o.label}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(
    `\nTOTAL  found ${tot.found}/${tot.expected} (majors ${tot.majorsFound}/${tot.majorsExpected})  traps ${tot.trapsHit}/${tot.traps}  other ${tot.unmatched} (${tot.loudUnmatched} crit/major)  ${tot.seconds}s\n→ ${path.relative(ROOT, file)}`,
  );
}

main();
