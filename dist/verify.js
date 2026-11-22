"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VERIFY_SCHEMA = exports.VERIFY_SYSTEM = void 0;
exports.shouldVerify = shouldVerify;
exports.codeForFinding = codeForFinding;
exports.codeForChange = codeForChange;
exports.codeForUnchangedFile = codeForUnchangedFile;
exports.evidenceInCode = evidenceInCode;
exports.verifyFindings = verifyFindings;
/**
 * Verification pass: a second, focused request per serious finding that must confirm it against the code
 * and quote the lines that show the problem. Drops confident misreadings (a `<span>` read as a `<div>`, a
 * value said to be empty inside the `if` that guarantees it isn't) without touching the first pass.
 *
 * No `vscode` imports.
 */
const context_1 = require("./context");
const diff_1 = require("./diff");
const markdown_1 = require("./markdown");
const parse_1 = require("./parse");
const types_1 = require("./types");
exports.VERIFY_SYSTEM = `You check one finding from an automated code review against the code. Automated reviewers are often wrong in specific ways: they misread a tag or name, miss a guard in an enclosing condition ({% if %}, if/else, early return), assume a value can be empty when the surrounding code rules that out, call something new that already existed, or describe code that isn't there. Your job is to decide whether the finding is actually true.

Read the code carefully, including unchanged lines (no marker) around the change. Then answer:
- "confirmed": the problem is real and is caused or exposed by the change.
- "rejected": the finding is false: the code doesn't do what it claims, the problem is prevented elsewhere in the shown code, or it is entirely about unchanged code that the change doesn't affect.
- "unsure": the shown code is not enough to tell.

"evidence" must be one to five lines copied exactly from the code shown (without the line number and marker) that prove your verdict. Do not paraphrase.

Respond with ONLY a JSON object:
{"verdict": "confirmed" | "rejected" | "unsure", "evidence": "<exact lines>", "reason": "<one or two sentences>", "severity": "critical" | "major" | "minor" | "nit"}`;
exports.VERIFY_SCHEMA = {
    type: 'object',
    properties: {
        verdict: { type: 'string', enum: ['confirmed', 'rejected', 'unsure'] },
        evidence: { type: 'string' },
        reason: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
    },
    required: ['verdict', 'evidence', 'reason'],
};
function shouldVerify(f, mode) {
    if (mode === 'off')
        return false;
    if (mode === 'all')
        return true;
    return f.severity === 'critical' || f.severity === 'major';
}
/** The code the verifier sees for a finding: as much of the file around the line as fits. */
function codeForFinding(f, file, maxChars) {
    if (!file)
        return '';
    if (file.content) {
        for (const r of [Infinity, 300, 150, 80, 40]) {
            const narrowed = Number.isFinite(r) && f.line ? { ...file, hunks: file.hunks.filter((h) => Math.abs(h.newStart - f.line) < r * 2 + h.newLines) } : file;
            const text = (0, diff_1.renderWithContext)(narrowed.hunks.length ? narrowed : file, file.content, r);
            if (text.length <= maxChars)
                return `=== File: ${file.path} ===\n${text}`;
        }
    }
    const text = (0, diff_1.annotateFile)(file);
    return text.length <= maxChars ? text : text.slice(0, maxChars) + '\n…[cut]';
}
/** The whole change, for a finding that names no file in it: each changed file gets an equal share of the room. */
function codeForChange(files, maxChars) {
    if (!files.length)
        return '';
    const each = Math.floor(maxChars / files.length);
    return files.map((file) => codeForFinding({ file: file.path, severity: 'minor', title: '', body: '', inline: false }, file, each)).filter(Boolean).join('\n\n');
}
/**
 * A finding on a file the change didn't touch (the model often blames a file it only saw as context): that file
 * around the line, read from the reviewed commit, followed by the change itself, since the finding is only
 * real if the change causes or exposes it. Empty when the path isn't safe or the file can't be read.
 */
async function codeForUnchangedFile(f, files, view, maxChars) {
    const p = (0, context_1.safeRepoPath)(f.file);
    if (!p)
        return '';
    const content = await view.read(p, 2_000_000).catch(() => undefined);
    if (content === undefined)
        return '';
    const own = Math.floor(maxChars * 0.4);
    // A hunk with no lines marks nothing as changed, so the file is shown as unchanged code around f.line.
    const around = { path: p, status: 'modified', binary: false, hunks: f.line ? [{ header: '', oldStart: f.line, oldLines: 1, newStart: f.line, newLines: 1, lines: [] }] : [] };
    let shown = '';
    for (const r of diff_1.RADII) {
        if (Number.isFinite(r) && !f.line)
            break;
        const text = (0, diff_1.renderWithContext)(around, content, r);
        if (text.length <= own) {
            shown = text;
            break;
        }
    }
    if (!shown)
        shown = content.slice(0, own) + '\n…[cut]';
    const header = `=== File: ${p} (not shown as part of the change; the finding is about this file) ===\n${shown}\n\nThe change under review:\n\n`;
    return header + codeForChange(files, maxChars - header.length);
}
/** What review.ts names a finding whose file the model didn't give. */
const UNKNOWN_FILE = '(unknown file)';
const norm = (s) => s.replace(/\s+/g, ' ').trim();
/** True when every non-empty evidence line appears in the code shown (ignoring whitespace, line numbers and markers). */
function evidenceInCode(evidence, code) {
    const lines = evidence
        .split('\n')
        .map((l) => l.replace(/^\s*\d+\s+[+\- ]\s/, '').replace(/^\s*[+-]\s/, ''))
        .map(norm)
        .filter((l) => l.length >= 3 && !/^(\.\.\.|…)$/.test(l));
    if (!lines.length)
        return false;
    const hay = norm(code.split('\n').map((l) => l.replace(/^\s*\d*\s[+\- ]\s/, '')).join('\n'));
    return lines.every((l) => hay.includes(l));
}
function lower(s) {
    return types_1.SEVERITIES[Math.min(types_1.SEVERITIES.length - 1, (0, types_1.severityRank)(s) + 1)];
}
/** Lower one step, unless that would drop it below the reported threshold (it would silently disappear). */
function lowerWithin(s, minimumSeverity) {
    const lowered = lower(s);
    return (0, types_1.severityRank)(lowered) > (0, types_1.severityRank)(minimumSeverity ?? 'nit') ? s : lowered;
}
/** Verify findings; returns the kept ones (with `verified`/`evidence`) and the rejected ones. */
async function verifyFindings(findings, files, opts) {
    const todo = findings.map((f, i) => ({ f, i })).filter(({ f }) => shouldVerify(f, opts.mode));
    if (!todo.length)
        return { kept: findings, rejected: [] };
    opts.log.info(`Verifying ${todo.length} finding(s)…`);
    const out = [...findings];
    const rejected = [];
    let next = 0;
    const worker = async () => {
        while (next < todo.length) {
            const { f, i } = todo[next++];
            if (opts.signal?.aborted)
                return;
            const file = files.find((x) => x.path === f.file);
            let code = codeForFinding(f, file, opts.maxChars);
            // Not a changed file: read it from the repo, or, if it names no readable file, check it against the whole change.
            // Normalise the path before the exclude check, so "x.pem/" or "a/./b" can't slip past a glob.
            const repoPath = !file && f.file !== UNKNOWN_FILE ? (0, context_1.safeRepoPath)(f.file) : undefined;
            if (!code && repoPath && opts.view && !opts.exclude?.(repoPath))
                code = await codeForUnchangedFile({ ...f, file: repoPath }, files, opts.view, opts.maxChars);
            if (!code && !file)
                code = codeForChange(files, opts.maxChars);
            if (!code) {
                // Nothing to check it against: don't let it through at full strength.
                out[i] = { ...f, severity: lowerWithin(f.severity, opts.minimumSeverity) };
                opts.log.warn(`Couldn't verify "${f.title}" (no code for ${f.file}); lowered to ${out[i].severity}.`);
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
                const res = await opts.llm.chat([
                    { role: 'system', content: exports.VERIFY_SYSTEM },
                    { role: 'user', content: user },
                ], { signal: opts.signal, schema: exports.VERIFY_SCHEMA });
                const v = (0, parse_1.parseJsonObject)(res.content);
                // No usable answer (cut off, still thinking, not JSON): the check didn't happen, so keep the finding as is.
                if (!v || typeof v.verdict !== 'string' || !['confirmed', 'rejected', 'unsure'].includes(v.verdict.toLowerCase())) {
                    opts.log.warn(`Verification of "${f.title}" gave no usable answer${res.truncated ? ' (output cut off)' : ''}; keeping it unchanged.`);
                    continue;
                }
                let verdict = v.verdict.toLowerCase();
                const evidence = typeof v?.evidence === 'string' ? (0, markdown_1.sanitizeText)(v.evidence).trim() : '';
                const reason = typeof v?.reason === 'string' ? (0, markdown_1.sanitizeText)(v.reason).trim() : '';
                // A confirmation must point at real code; one that quotes code that isn't there is a misreading.
                if (verdict === 'confirmed' && !evidenceInCode(evidence, code))
                    verdict = 'unsure';
                opts.log.info(`  verify ${f.file}:${f.line ?? '?'} "${f.title}": ${verdict}${reason ? ` (${reason})` : ''}`);
                if (verdict === 'rejected') {
                    rejected.push({ ...f, verified: false, evidence: [evidence, reason].filter(Boolean).join('\n— ') || undefined });
                    out[i] = null;
                }
                else if (verdict === 'confirmed') {
                    out[i] = { ...f, verified: true, evidence: evidence || undefined };
                }
                else {
                    out[i] = { ...f, severity: lowerWithin(f.severity, opts.minimumSeverity) };
                }
            }
            catch (e) {
                if (opts.signal?.aborted)
                    return;
                opts.log.warn(`Verification of "${f.title}" failed (${e.message}); keeping it.`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, todo.length)) }, worker));
    return { kept: out.filter((x) => !!x), rejected };
}
