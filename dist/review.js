"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CancelledError = void 0;
exports.selectFiles = selectFiles;
exports.runReview = runReview;
exports.normalizeSeverity = normalizeSeverity;
exports.cleanPath = cleanPath;
exports.mapLines = mapLines;
exports.normalizeFindings = normalizeFindings;
const diff_1 = require("./diff");
const llm_1 = require("./llm");
const markdown_1 = require("./markdown");
const parse_1 = require("./parse");
const prompt_1 = require("./prompt");
const types_1 = require("./types");
class CancelledError extends Error {
    constructor() {
        super('Review cancelled');
    }
}
exports.CancelledError = CancelledError;
/** Decide which files go to the model. */
function selectFiles(files, exclude) {
    const included = [];
    const skipped = [];
    for (const f of files) {
        if (f.binary)
            skipped.push({ path: f.path, reason: 'binary' });
        else if (f.status === 'deleted')
            skipped.push({ path: f.path, reason: 'deleted' });
        else if (exclude(f.path))
            skipped.push({ path: f.path, reason: 'excluded by diffLeppard.excludeGlobs' });
        else if (!f.hunks.some((h) => h.lines.some((l) => l.kind === 'add'))) {
            skipped.push({ path: f.path, reason: f.status === 'renamed' ? 'pure rename' : 'no added lines' });
        }
        else
            included.push(f);
    }
    return { included, skipped };
}
async function runReview(files, opts) {
    const started = Date.now();
    const { included, skipped } = selectFiles(files, opts.exclude);
    skipped.unshift(...(opts.preSkipped ?? []));
    const result = {
        summary: '',
        findings: [],
        model: opts.llm.model,
        reviewedFiles: included.map((f) => f.path),
        skippedFiles: skipped,
        chunkCount: 0,
        errors: [],
        durationMs: 0,
    };
    if (!included.length) {
        result.summary = 'Nothing to review: no reviewable added lines.';
        result.durationMs = Date.now() - started;
        return result;
    }
    const chunks = (0, diff_1.chunkDiff)(included, opts.maxChunkChars);
    result.chunkCount = chunks.length;
    opts.log.info(`Reviewing ${included.length} file(s) in ${chunks.length} chunk(s) with ${opts.llm.model}`);
    for (const s of skipped)
        opts.log.info(`  skipped ${s.path}: ${s.reason}`);
    const summaries = new Array(chunks.length);
    const findings = new Array(chunks.length);
    let done = 0;
    const progressPerChunk = 100 / (chunks.length + (chunks.length > 1 ? 0.5 : 0));
    const work = async (i) => {
        if (opts.signal?.aborted)
            throw new CancelledError();
        const label = chunks.length > 1 ? `Part ${i + 1}/${chunks.length}` : 'Reviewing';
        try {
            const r = await reviewChunk(chunks[i], i, chunks.length, opts, (chars) => opts.onProgress?.(`${label}: receiving… (${chars} chars, ${done}/${chunks.length} parts done)`));
            summaries[i] = r.summary === undefined ? undefined : (0, markdown_1.sanitizeText)(r.summary);
            findings[i] = r.findings;
        }
        catch (e) {
            if (opts.signal?.aborted)
                throw new CancelledError();
            const msg = `Part ${i + 1}/${chunks.length} (${chunks[i].files.map((f) => f.path).join(', ')}): ${e.message}`;
            opts.log.error(msg);
            result.errors.push(msg);
            findings[i] = [];
        }
        done++;
        opts.onProgress?.(`${done}/${chunks.length} parts done`, progressPerChunk);
    };
    await pool(chunks.length, Math.max(1, opts.concurrency), work);
    if (result.errors.length === chunks.length) {
        throw new llm_1.LlmError(result.errors[0]);
    }
    const minRank = (0, types_1.severityRank)(opts.minimumSeverity);
    const all = dedupe(findings.flat()).filter((f) => (0, types_1.severityRank)(f.severity) <= minRank);
    all.sort((a, b) => (0, types_1.severityRank)(a.severity) - (0, types_1.severityRank)(b.severity) ||
        a.file.localeCompare(b.file) ||
        (a.line ?? 0) - (b.line ?? 0));
    result.findings = all;
    const dropped = findings.flat().length - all.length;
    if (dropped > 0)
        opts.log.info(`Dropped ${dropped} finding(s) below '${opts.minimumSeverity}' severity or duplicated`);
    const partSummaries = summaries.filter((s) => !!s?.trim());
    if (chunks.length > 1 && partSummaries.length > 1) {
        opts.onProgress?.('Writing overall summary…');
        try {
            const r = await opts.llm.chat((0, prompt_1.buildSynthesisMessages)(opts.context.title, partSummaries, all.map((f) => `[${f.severity}] ${f.file}: ${f.title}`)), { signal: opts.signal, schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } });
            result.summary = (0, markdown_1.sanitizeText)((0, parse_1.parseModelOutput)(r.content).summary ?? '').trim() || partSummaries.join(' ');
        }
        catch (e) {
            if (opts.signal?.aborted)
                throw new CancelledError();
            opts.log.warn(`Summary synthesis failed: ${e.message}`);
            result.summary = partSummaries.join('\n\n');
        }
    }
    else {
        result.summary = partSummaries[0] ?? '';
    }
    result.durationMs = Date.now() - started;
    return result;
}
async function reviewChunk(chunk, index, count, opts, onChars) {
    const messages = (0, prompt_1.buildReviewMessages)(chunk, { ...opts.context, chunkIndex: index, chunkCount: count });
    opts.log.debug(`--- prompt part ${index + 1}/${count} (${messages.map((m) => m.content.length).reduce((a, b) => a + b)} chars) ---`);
    let res = await opts.llm.chat(messages, { signal: opts.signal, schema: prompt_1.REVIEW_JSON_SCHEMA, onProgress: onChars });
    opts.log.debug(`--- raw model output part ${index + 1} ---\n${res.content}`);
    if (res.runaway)
        opts.log.warn(`Part ${index + 1}: the model started repeating itself and was stopped; salvaging what parsed.`);
    else if (res.truncated)
        opts.log.warn(`Part ${index + 1}: output hit maxOutputTokens and was cut off; salvaging what parsed.`);
    let parsed = (0, parse_1.parseModelOutput)(res.content);
    if (!parsed.ok) {
        opts.log.warn(`Part ${index + 1}: could not parse model output as JSON, asking once more.`);
        const nudge = res.runaway
            ? 'You started repeating the same text over and over, so your reply was cut off. Reply again with ONLY the JSON object described in the instructions, listing each finding once.'
            : 'That was not valid JSON. Reply again with ONLY the JSON object described in the instructions.';
        res = await opts.llm.chat([
            ...messages,
            { role: 'assistant', content: res.content.slice(0, 4000) },
            { role: 'user', content: nudge },
        ], { signal: opts.signal, schema: prompt_1.REVIEW_JSON_SCHEMA, onProgress: onChars });
        opts.log.debug(`--- raw model output part ${index + 1} (retry) ---\n${res.content}`);
        parsed = (0, parse_1.parseModelOutput)(res.content);
        if (!parsed.ok)
            throw new Error('Model did not return parseable JSON (see the output channel for the raw reply)');
    }
    const findings = normalizeFindings(parsed.findings, chunk.files);
    return { summary: parsed.summary, findings };
}
// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------
function str(v) {
    if (typeof v === 'string')
        return (0, markdown_1.sanitizeText)(v).trim();
    if (typeof v === 'number')
        return String(v);
    return '';
}
function toInt(v) {
    if (typeof v === 'number' && Number.isFinite(v))
        return Math.trunc(v);
    if (typeof v === 'string') {
        const m = /\d+/.exec(v);
        if (m)
            return parseInt(m[0], 10);
    }
    return undefined;
}
const SEVERITY_ALIASES = {
    critical: 'critical',
    blocker: 'critical',
    severe: 'critical',
    major: 'major',
    high: 'major',
    error: 'major',
    important: 'major',
    minor: 'minor',
    medium: 'minor',
    moderate: 'minor',
    warning: 'minor',
    nit: 'nit',
    nitpick: 'nit',
    low: 'nit',
    info: 'nit',
    trivial: 'nit',
    suggestion: 'nit',
    style: 'nit',
};
function normalizeSeverity(v) {
    const s = str(v).toLowerCase();
    if (types_1.SEVERITIES.includes(s))
        return s;
    return SEVERITY_ALIASES[s] ?? 'minor';
}
function cleanPath(p) {
    return p
        .trim()
        .replace(/^=+\s*File:\s*/i, '')
        .replace(/\s*\((added|modified|deleted|renamed[^)]*|continued[^)]*)\)\s*=*\s*$/i, '')
        .replace(/^["'`]|["'`]$/g, '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^[ab]\//, '')
        .replace(/^\/+/, '');
}
function matchFile(name, files) {
    if (!name)
        return files.length === 1 ? files[0] : undefined;
    const exact = files.find((f) => f.path === name);
    if (exact)
        return exact;
    const suffix = files.filter((f) => f.path.endsWith('/' + name) || name.endsWith('/' + f.path));
    if (suffix.length === 1)
        return suffix[0];
    const base = name.split('/').pop();
    const byBase = files.filter((f) => f.path.split('/').pop() === base);
    return byBase.length === 1 ? byBase[0] : undefined;
}
const SNAP_DISTANCE = 3;
/** Map a model-provided line range onto lines that are actually in the diff. */
const lineMapCache = new WeakMap();
function lineMaps(file) {
    let m = lineMapCache.get(file);
    if (!m)
        lineMapCache.set(file, (m = { commentable: (0, diff_1.commentableLines)(file), added: (0, diff_1.addedLines)(file) }));
    return m;
}
function mapLines(file, line, endLine) {
    if (line === undefined || line < 1)
        return { inline: false, adjusted: false };
    const { commentable, added } = lineMaps(file);
    let l = line;
    let adjusted = false;
    if (!commentable.has(l)) {
        let best;
        for (let d = 1; d <= SNAP_DISTANCE && best === undefined; d++) {
            const cands = [l - d, l + d].filter((x) => commentable.has(x));
            best = cands.find((x) => added.has(x)) ?? cands[0];
        }
        if (best === undefined)
            return { line, endLine, inline: false, adjusted: false };
        l = best;
        adjusted = true;
    }
    let e = endLine;
    if (e !== undefined && (adjusted || e <= l || commentable.get(e) !== commentable.get(l)))
        e = undefined;
    if (e !== undefined) {
        for (let x = l; x <= e; x++) {
            if (!commentable.has(x)) {
                e = undefined;
                break;
            }
        }
    }
    // A multi-line range we couldn't keep means the location (and any replacement code) is approximate:
    // flag it so the comment is never rendered as a one-click suggestion over the wrong lines.
    if (endLine !== undefined && endLine > line && e === undefined)
        adjusted = true;
    return { line: l, endLine: e, inline: true, adjusted };
}
function normalizeFindings(raw, files) {
    const out = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object')
            continue;
        const body = str(r.body) || str(r.comment) || str(r.message) || str(r.description);
        let title = str(r.title);
        if (!title && !body)
            continue;
        if (!title)
            title = body.split(/(?<=[.!?])\s|\n/)[0].slice(0, 100);
        const name = cleanPath(str(r.file) || str(r.path));
        const file = matchFile(name, files);
        const severity = normalizeSeverity(r.severity);
        let suggestion = typeof r.suggestion === 'string' ? (0, markdown_1.sanitizeText)(r.suggestion) : undefined;
        if (suggestion) {
            const fence = /^```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(suggestion.trim());
            if (fence)
                suggestion = fence[1];
            if (!suggestion.trim())
                suggestion = undefined;
        }
        const category = str(r.category).toLowerCase() || undefined;
        const rawLine = toInt(r.line ?? r.start_line);
        const rawEnd = toInt(r.endLine ?? r.end_line);
        if (!file) {
            out.push({ file: name || '(unknown file)', line: rawLine, severity, category, title, body, suggestion, inline: false });
            continue;
        }
        const m = mapLines(file, rawLine, rawEnd);
        out.push({
            file: file.path,
            line: m.line,
            endLine: m.endLine,
            severity,
            category,
            title,
            body,
            suggestion,
            inline: m.inline,
            lineAdjusted: m.adjusted || undefined,
        });
    }
    return out;
}
function dedupe(findings) {
    const seen = new Set();
    return findings.filter((f) => {
        const key = `${f.file}|${f.line ?? ''}|${f.title.toLowerCase().replace(/\W+/g, ' ').trim()}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
async function pool(n, concurrency, fn) {
    let next = 0;
    const width = Number.isFinite(concurrency) && concurrency >= 1 ? Math.min(n, Math.floor(concurrency)) : 1;
    const runners = Array.from({ length: width }, async () => {
        while (next < n) {
            const i = next++;
            await fn(i);
        }
    });
    await Promise.all(runners);
}
