/**
 * Verification pass: a second, focused request per serious finding that must confirm it against the code
 * and quote the lines that show the problem. Drops confident misreadings (a `<span>` read as a `<div>`, a
 * value said to be empty inside the `if` that guarantees it isn't) without touching the first pass.
 *
 * No `vscode` imports.
 */
import { RepoView, safeRepoPath } from './context';
import { annotateFile, RADII, renderWithContext } from './diff';
import { LlmClient } from './llm';
import { sanitizeText } from './markdown';
import { parseJsonObject } from './parse';
import type { VerifyMode } from './config';
import { FileDiff, Finding, Logger, Severity, SEVERITIES, severityRank } from './types';


export const VERIFY_SYSTEM = `You check one finding from an automated code review against the code. Automated reviewers are often wrong in specific ways: they misread a tag or name, miss a guard in an enclosing condition ({% if %}, if/else, early return), assume a value can be empty when the surrounding code rules that out, call something new that already existed, or describe code that isn't there. Your job is to decide whether the finding is actually true.

Read the code carefully, including unchanged lines (no marker) around the change. Then answer:
- "confirmed": the problem is real and is caused or exposed by the change.
- "rejected": the finding is false: the code doesn't do what it claims, the problem is prevented elsewhere in the shown code, or it is entirely about unchanged code that the change doesn't affect.
- "unsure": the shown code is not enough to tell.

"evidence" must be one to five lines copied exactly from the code shown (without the line number and marker) that prove your verdict. Do not paraphrase.

Respond with ONLY a JSON object:
{"verdict": "confirmed" | "rejected" | "unsure", "evidence": "<exact lines>", "reason": "<one or two sentences>", "severity": "critical" | "major" | "minor" | "nit"}`;

export const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'rejected', 'unsure'] },
    evidence: { type: 'string' },
    reason: { type: 'string' },
    severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
  },
  required: ['verdict', 'evidence', 'reason'],
};

export function shouldVerify(f: Finding, mode: VerifyMode): boolean {
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return f.severity === 'critical' || f.severity === 'major';
}

/** The code the verifier sees for a finding: as much of the file around the line as fits. */
export function codeForFinding(f: Finding, file: FileDiff | undefined, maxChars: number): string {
  if (!file) return '';
  if (file.content) {
    for (const r of [Infinity, 300, 150, 80, 40]) {
      const narrowed = Number.isFinite(r) && f.line ? { ...file, hunks: file.hunks.filter((h) => Math.abs(h.newStart - f.line!) < r * 2 + h.newLines) } : file;
      const text = renderWithContext(narrowed.hunks.length ? narrowed : file, file.content, r);
      if (text.length <= maxChars) return `=== File: ${file.path} ===\n${text}`;
    }
  }
  const text = annotateFile(file);
  return text.length <= maxChars ? text : text.slice(0, maxChars) + '\n…[cut]';
}

/** Code-like words in a finding: `quoted` spans, camelCase, snake_case and dotted names. */
export function findingTerms(f: Pick<Finding, 'title' | 'body'>): string[] {
  const text = `${f.title}\n${f.body}`;
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) out.add(m[1].trim().toLowerCase());
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*(?:[._][\w$]+)+|[a-z]+[A-Z][\w$]*|[A-Z][a-z]+[A-Z][\w$]*/g)) out.add(m[0].toLowerCase());
  return [...out].filter((t) => t.length >= 3);
}

const hunkText = (h: FileDiff['hunks'][number]) => h.lines.map((l) => l.text).join('\n').toLowerCase();

/** Most files shown for a finding that names no file; the rest are listed by path only. */
const MAX_CHANGE_FILES = 8;

/**
 * The whole change, for a finding that names no file in it. Files the finding mentions (by path, name or a term
 * found in their hunks) come first and get more room; at most MAX_CHANGE_FILES are shown, and the total stays
 * within maxChars. A file that doesn't fit in its share keeps the hunks that mention the finding's terms first.
 */
export function codeForChange(files: FileDiff[], maxChars: number, f?: Pick<Finding, 'title' | 'body'>): string {
  if (!files.length || maxChars <= 0) return '';
  const text = f ? `${f.title}\n${f.body}`.toLowerCase() : '';
  const terms = f ? findingTerms(f) : [];
  const scored = files.map((file, i) => {
    const base = file.path.split('/').pop()!.toLowerCase();
    let score = text.includes(file.path.toLowerCase()) ? 4 : base.length >= 3 && text.includes(base) ? 3 : 0;
    const hunks = file.hunks.map((h) => {
      const t = hunkText(h);
      return terms.filter((w) => t.includes(w)).length;
    });
    if (hunks.some((n) => n > 0)) score += 1 + Math.min(2, Math.max(...hunks));
    return { file, i, score, hunks };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const shown = scored.slice(0, MAX_CHANGE_FILES);
  const left = scored.slice(MAX_CHANGE_FILES).map((x) => x.file.path);
  // Room for the list of files not shown: what the known ones need, plus a little for files dropped below.
  const listed = left.slice(0, 20).reduce((n, p) => n + Math.min(p.length, 78) + 2, 60);
  let room = maxChars - Math.min(listed + 200, maxChars >> 2);
  if (room <= 0) return '';
  const weight = (x: (typeof shown)[number]) => (x.score > 0 ? 2 : 1);
  let weights = shown.reduce((n, x) => n + weight(x), 0);
  const parts: string[] = [];
  const CUT = '\n…[cut]'.length;
  for (const x of shown) {
    const sep = parts.length ? 2 : 0;
    const share = Math.floor(((room - sep) * weight(x)) / weights) - CUT;
    weights -= weight(x);
    if (share <= 40) {
      left.push(x.file.path);
      continue;
    }
    const blank = { file: x.file.path, severity: 'minor' as Severity, title: '', body: '', inline: false };
    let code = codeForFinding(blank, x.file, share);
    if (code.length > share && x.hunks.some((n) => n > 0)) {
      // Too big for its share: show the hunks the finding talks about rather than whatever comes first.
      const order = x.file.hunks.map((h, j) => ({ h, n: x.hunks[j], j })).sort((a, b) => b.n - a.n || a.j - b.j);
      for (let k = order.length; k > 0; k--) {
        const pick = order.slice(0, k).sort((a, b) => a.j - b.j).map((o) => o.h);
        const narrowed = codeForFinding(blank, { ...x.file, hunks: pick }, share);
        if (narrowed.length <= share || k === 1) {
          code = narrowed;
          break;
        }
      }
    }
    if (!code) {
      left.push(x.file.path);
      continue;
    }
    code = code.slice(0, room - sep);
    parts.push(code);
    room -= code.length + sep;
  }
  const body = parts.join('\n\n');
  if (!left.length) return body;
  const names = left.slice(0, 20).map((p) => (p.length > 78 ? '…' + p.slice(-77) : p));
  const tail = `\n\n(${left.length} more changed file(s) not shown: ${names.join(', ')}${left.length > 20 ? ', …' : ''})`;
  return body + tail.slice(0, Math.max(0, maxChars - body.length));
}

/**
 * A finding on a file the change didn't touch (the model often blames a file it only saw as context): that file
 * around the line, read from the reviewed commit, followed by the change itself, since the finding is only
 * real if the change causes or exposes it. Empty when the path isn't safe or the file can't be read.
 */
export async function codeForUnchangedFile(f: Finding, files: FileDiff[], view: RepoView, maxChars: number, changedReason?: string): Promise<string> {
  const p = safeRepoPath(f.file);
  if (!p) return '';
  const content = await view.read(p, 2_000_000).catch(() => undefined);
  if (content === undefined) return '';
  const own = Math.floor(maxChars * 0.4);
  // A hunk with no lines marks nothing as changed, so the file is shown as unchanged code around f.line.
  const around: FileDiff = { path: p, status: 'modified', binary: false, hunks: f.line ? [{ header: '', oldStart: f.line, oldLines: 1, newStart: f.line, newLines: 1, lines: [] }] : [] };
  let shown = '';
  for (const r of RADII) {
    if (Number.isFinite(r) && !f.line) break;
    const text = renderWithContext(around, content, r);
    if (text.length <= own) {
      shown = text;
      break;
    }
  }
  if (!shown) shown = content.slice(0, own) + '\n…[cut]';
  const note = changedReason
    ? `changed by this change, but its diff isn't shown (${changedReason}); shown as it is after the change, so lines here may be new`
    : 'not shown as part of the change; the finding is about this file';
  const header = `=== File: ${p} (${note}) ===\n${shown}\n\nThe change under review:\n\n`;
  return header + codeForChange(files, maxChars - header.length, f);
}

/** What review.ts names a finding whose file the model didn't give. */
const UNKNOWN_FILE = '(unknown file)';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** True when every non-empty evidence line appears in the code shown (ignoring whitespace, line numbers and markers). */
export function evidenceInCode(evidence: string, code: string): boolean {
  const lines = evidence
    .split('\n')
    .map((l) => l.replace(/^\s*\d+\s+[+\- ]\s/, '').replace(/^\s*[+-]\s/, ''))
    .map(norm)
    .filter((l) => l.length >= 3 && !/^(\.\.\.|…)$/.test(l));
  if (!lines.length) return false;
  const hay = norm(code.split('\n').map((l) => l.replace(/^\s*\d*\s[+\- ]\s/, '')).join('\n'));
  return lines.every((l) => hay.includes(l));
}

function lower(s: Severity): Severity {
  return SEVERITIES[Math.min(SEVERITIES.length - 1, severityRank(s) + 1)];
}

/** Lower one step, unless that would drop it below the reported threshold (it would silently disappear). */
function lowerWithin(s: Severity, minimumSeverity: Severity | undefined): Severity {
  const lowered = lower(s);
  return severityRank(lowered) > severityRank(minimumSeverity ?? 'nit') ? s : lowered;
}

export interface VerifyOptions {
  llm: LlmClient;
  mode: VerifyMode;
  /** "Unsure" lowers a finding's severity, but never below this (it would silently disappear). */
  minimumSeverity?: Severity;
  maxChars: number;
  concurrency: number;
  log: Logger;
  signal?: AbortSignal;
  /** The repo at the reviewed commit, to check findings on files outside the change. */
  view?: RepoView;
  /** Paths excluded from review; findings on them aren't read from the repo. */
  exclude?: (path: string) => boolean;
  /** Changed files the review left out (too large, pure renames, …) with why; findings on them are labelled as changed. */
  changedNotShown?: { path: string; reason: string }[];
}

/** Verify findings; returns the kept ones (with `verified`/`evidence`) and the rejected ones. */
export async function verifyFindings(findings: Finding[], files: FileDiff[], opts: VerifyOptions): Promise<{ kept: Finding[]; rejected: Finding[] }> {
  const todo = findings.map((f, i) => ({ f, i })).filter(({ f }) => shouldVerify(f, opts.mode));
  if (!todo.length) return { kept: findings, rejected: [] };
  opts.log.info(`Verifying ${todo.length} finding(s)…`);
  const out: (Finding | null)[] = [...findings];
  const rejected: Finding[] = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { f, i } = todo[next++];
      if (opts.signal?.aborted) return;
      const file = files.find((x) => x.path === f.file);
      let code = codeForFinding(f, file, opts.maxChars);
      // Not a changed file: read it from the repo, or, if it names no readable file, check it against the whole change.
      // Normalise the path before the exclude check, so "x.pem/" or "a/./b" can't slip past a glob.
      const repoPath = !file && f.file !== UNKNOWN_FILE ? safeRepoPath(f.file) : undefined;
      if (!code && repoPath && opts.view && !opts.exclude?.(repoPath)) code = await codeForUnchangedFile({ ...f, file: repoPath }, files, opts.view, opts.maxChars, opts.changedNotShown?.find((x) => safeRepoPath(x.path) === repoPath)?.reason);
      if (!code && !file) code = codeForChange(files, opts.maxChars, f);
      if (!code) {
        // Nothing to check it against: don't let it through at full strength.
        out[i] = { ...f, severity: lowerWithin(f.severity, opts.minimumSeverity) };
        opts.log.warn(`Couldn't verify "${f.title}" (no code for ${f.file}); lowered to ${out[i]!.severity}.`);
        continue;
      }
      const user = [
        `Finding (${f.severity}${f.category ? `, ${f.category}` : ''}) at ${f.file}${f.line ? `:${f.line}` : ''}:`,
        `Title: ${f.title}`,
        `Explanation: ${f.body}`,
        `Code (each line: <new-file line number> <marker> <code>; "+" added, "-" removed, " " unchanged):\n\n${code}`,
        'Respond with the JSON object only.',
      ].join('\n\n');
      try {
        const res = await opts.llm.chat(
          [
            { role: 'system', content: VERIFY_SYSTEM },
            { role: 'user', content: user },
          ],
          { signal: opts.signal, schema: VERIFY_SCHEMA },
        );
        const v = parseJsonObject(res.content);
        // No usable answer (cut off, still thinking, not JSON): the check didn't happen, so keep the finding as is.
        if (!v || typeof v.verdict !== 'string' || !['confirmed', 'rejected', 'unsure'].includes(v.verdict.toLowerCase())) {
          opts.log.warn(`Verification of "${f.title}" gave no usable answer${res.truncated ? ' (output cut off)' : ''}; keeping it unchanged.`);
          continue;
        }
        let verdict = v.verdict.toLowerCase();
        const evidence = typeof v?.evidence === 'string' ? sanitizeText(v.evidence).trim() : '';
        const reason = typeof v?.reason === 'string' ? sanitizeText(v.reason).trim() : '';
        // A confirmation must point at real code; one that quotes code that isn't there is a misreading.
        if (verdict === 'confirmed' && !evidenceInCode(evidence, code)) verdict = 'unsure';
        opts.log.info(`  verify ${f.file}:${f.line ?? '?'} "${f.title}": ${verdict}${reason ? ` (${reason})` : ''}`);
        if (verdict === 'rejected') {
          rejected.push({ ...f, verified: false, evidence: [evidence, reason].filter(Boolean).join('\n— ') || undefined });
          out[i] = null;
        } else if (verdict === 'confirmed') {
          out[i] = { ...f, verified: true, evidence: evidence || undefined };
        } else {
          out[i] = { ...f, severity: lowerWithin(f.severity, opts.minimumSeverity) };
        }
      } catch (e) {
        if (opts.signal?.aborted) return;
        opts.log.warn(`Verification of "${f.title}" failed (${(e as Error).message}); keeping it.`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, todo.length)) }, worker));
  return { kept: out.filter((x): x is Finding => !!x), rejected };
}
