/**
 * Robustly extract the review JSON from model output. Local models wrap JSON in fences,
 * add chatter, emit <think> blocks, or get cut off by max_tokens; we cope with all of that.
 */

export interface RawFinding {
  file?: unknown;
  path?: unknown;
  line?: unknown;
  start_line?: unknown;
  endLine?: unknown;
  end_line?: unknown;
  severity?: unknown;
  category?: unknown;
  title?: unknown;
  body?: unknown;
  comment?: unknown;
  message?: unknown;
  description?: unknown;
  suggestion?: unknown;
}

export interface ParsedOutput {
  summary?: string;
  findings: RawFinding[];
  /** False when nothing usable could be parsed. */
  ok: boolean;
  /** True when we had to salvage partial output. */
  partial: boolean;
}

export function stripThinking(text: string): string {
  // Remove complete <think>…</think> blocks, and a dangling closing tag (some servers drop the opener).
  let t = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
  const close = /<\/(think|thinking|reasoning)>/i.exec(t);
  if (close) t = t.slice(close.index + close[0].length);
  return t.trim();
}

function stripFences(text: string): string {
  const m = /```(?:json|JSON)?\s*\n([\s\S]*?)\n?```/.exec(text);
  return m ? m[1] : text;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    // Trailing commas are a common small-model mistake.
    try {
      return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return undefined;
    }
  }
}

/** Scan for balanced top-level {...} objects starting at `from`, respecting strings. */
function scanObjects(text: string, from = 0): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

function fromObject(obj: unknown): ParsedOutput | undefined {
  if (Array.isArray(obj)) return { findings: obj as RawFinding[], ok: true, partial: false };
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  const list = o.findings ?? o.comments ?? o.issues ?? o.review_comments ?? o.problems;
  const summary = typeof o.summary === 'string' ? o.summary : typeof o.overview === 'string' ? o.overview : undefined;
  if (Array.isArray(list)) return { summary, findings: list as RawFinding[], ok: true, partial: false };
  if (summary !== undefined) return { summary, findings: [], ok: true, partial: false };
  // A single finding object on its own.
  if ('title' in o || 'body' in o) return { findings: [o as RawFinding], ok: true, partial: false };
  return undefined;
}

export function parseModelOutput(raw: string): ParsedOutput {
  const text = stripFences(stripThinking(raw)).trim();
  if (!text) return { findings: [], ok: false, partial: false };

  const direct = fromObject(tryParse(text));
  if (direct) return direct;

  // Find the outermost JSON object somewhere in the text.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const inner = fromObject(tryParse(text.slice(first, last + 1)));
    if (inner) return inner;
  }
  const arrFirst = text.indexOf('[');
  const arrLast = text.lastIndexOf(']');
  if (arrFirst >= 0 && arrLast > arrFirst && (first < 0 || arrFirst < first)) {
    const arr = fromObject(tryParse(text.slice(arrFirst, arrLast + 1)));
    if (arr) return arr;
  }

  // Salvage: output was probably truncated. Take the summary if present and every complete finding object.
  const summaryMatch = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  const summary = summaryMatch ? (tryParse(`"${summaryMatch[1]}"`) as string | undefined) : undefined;
  const findingsKey = /"(findings|comments|issues)"\s*:\s*\[/.exec(text);
  const findings: RawFinding[] = [];
  if (findingsKey) {
    for (const s of scanObjects(text, findingsKey.index + findingsKey[0].length)) {
      const o = tryParse(s);
      if (o && typeof o === 'object' && !Array.isArray(o)) findings.push(o as RawFinding);
    }
  }
  if (summary !== undefined || findings.length) return { summary, findings, ok: true, partial: true };
  return { findings: [], ok: false, partial: false };
}
