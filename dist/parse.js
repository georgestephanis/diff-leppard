"use strict";
/**
 * Robustly extract the review JSON from model output. Local models wrap JSON in fences,
 * add chatter, emit <think> blocks, or get cut off by max_tokens; we cope with all of that.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripThinking = stripThinking;
exports.parseModelOutput = parseModelOutput;
/**
 * Remove reasoning that some models emit before their answer: leading <think>…</think> blocks, or
 * everything up to a dangling </think> (some servers drop the opening tag). Only text before the first
 * `{` / `[` is touched, so think tags quoted inside the JSON answer (e.g. reviewing code that handles
 * them) survive.
 */
function stripThinking(text) {
    let t = text.trimStart();
    for (;;) {
        const m = /^<(think|thinking|reasoning)>[\s\S]*?<\/\1>\s*/i.exec(t);
        if (!m)
            break;
        t = t.slice(m[0].length);
    }
    const jsonStart = t.search(/[{[]/);
    const close = /<\/(think|thinking|reasoning)>/i.exec(t);
    if (close && (jsonStart < 0 || close.index < jsonStart))
        t = t.slice(close.index + close[0].length);
    return t.trim();
}
/** Contents of every fenced code block, in order. */
function fencedBlocks(text) {
    const out = [];
    const re = /^```[\w-]*[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;
    let m;
    while ((m = re.exec(text)))
        out.push(m[1]);
    return out;
}
function tryParse(s) {
    try {
        return JSON.parse(s);
    }
    catch {
        // Trailing commas are a common small-model mistake.
        try {
            return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
        }
        catch {
            return undefined;
        }
    }
}
/** Scan for balanced top-level {...} objects starting at `from`, respecting strings. */
function scanObjects(text, from = 0) {
    const out = [];
    let depth = 0;
    let start = -1;
    let inStr = false;
    let esc = false;
    for (let i = from; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (esc)
                esc = false;
            else if (c === '\\')
                esc = true;
            else if (c === '"')
                inStr = false;
            continue;
        }
        if (c === '"')
            inStr = true;
        else if (c === '{') {
            if (depth === 0)
                start = i;
            depth++;
        }
        else if (c === '}' && depth > 0) {
            depth--;
            if (depth === 0 && start >= 0) {
                out.push(text.slice(start, i + 1));
                start = -1;
            }
        }
    }
    return out;
}
function fromObject(obj) {
    if (Array.isArray(obj))
        return { findings: obj, ok: true, partial: false };
    if (!obj || typeof obj !== 'object')
        return undefined;
    const o = obj;
    const list = o.findings ?? o.comments ?? o.issues ?? o.review_comments ?? o.problems;
    const summary = typeof o.summary === 'string' ? o.summary : typeof o.overview === 'string' ? o.overview : undefined;
    if (Array.isArray(list))
        return { summary, findings: list, ok: true, partial: false };
    if (summary !== undefined)
        return { summary, findings: [], ok: true, partial: false };
    // A single finding object on its own.
    if ('title' in o || 'body' in o)
        return { findings: [o], ok: true, partial: false };
    return undefined;
}
function parseCandidate(text) {
    const direct = fromObject(tryParse(text));
    if (direct)
        return direct;
    // The outermost JSON object somewhere in the text.
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
        const inner = fromObject(tryParse(text.slice(first, last + 1)));
        if (inner)
            return inner;
    }
    const arrFirst = text.indexOf('[');
    const arrLast = text.lastIndexOf(']');
    if (arrFirst >= 0 && arrLast > arrFirst && (first < 0 || arrFirst < first)) {
        const arr = fromObject(tryParse(text.slice(arrFirst, arrLast + 1)));
        if (arr)
            return arr;
    }
    return undefined;
}
function parseModelOutput(raw) {
    const text = stripThinking(raw);
    if (!text)
        return { findings: [], ok: false, partial: false };
    // Fenced blocks first (the usual "```json" wrapper), then the whole reply.
    for (const candidate of [...fencedBlocks(text), text]) {
        const parsed = parseCandidate(candidate.trim());
        if (parsed)
            return parsed;
    }
    // Salvage: output was probably truncated. Take the summary if present and every complete finding object.
    const summaryMatch = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    const summary = summaryMatch ? tryParse(`"${summaryMatch[1]}"`) : undefined;
    const findingsKey = /"(findings|comments|issues)"\s*:\s*\[/.exec(text);
    const findings = [];
    if (findingsKey) {
        for (const s of scanObjects(text, findingsKey.index + findingsKey[0].length)) {
            const o = tryParse(s);
            if (o && typeof o === 'object' && !Array.isArray(o))
                findings.push(o);
        }
    }
    if (summary !== undefined || findings.length)
        return { summary, findings, ok: true, partial: true };
    return { findings: [], ok: false, partial: false };
}
