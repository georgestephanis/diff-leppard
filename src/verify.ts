/**
 * Verification pass: a second, focused request per serious finding that must confirm it against the code
 * and quote the lines that show the problem. Drops confident misreadings (a `<span>` read as a `<div>`, a
 * value said to be empty inside the `if` that guarantees it isn't) without touching the first pass.
 *
 * No `vscode` imports.
 */
import { annotateFile, renderWithContext } from './diff';
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

export interface VerifyOptions {
  llm: LlmClient;
  mode: VerifyMode;
  maxChars: number;
  concurrency: number;
  log: Logger;
  signal?: AbortSignal;
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
      const code = codeForFinding(f, file, opts.maxChars);
      if (!code) continue;
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
          { signal: opts.signal, schema: VERIFY_SCHEMA, maxTokens: 1024 },
        );
        const v = parseJsonObject(res.content);
        let verdict = typeof v?.verdict === 'string' ? v.verdict.toLowerCase() : 'unsure';
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
          out[i] = { ...f, severity: lower(f.severity) };
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
