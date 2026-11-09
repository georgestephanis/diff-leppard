import { addedLines, Chunk, chunkDiff, commentableLines } from './diff';
import { LlmClient, LlmError } from './llm';
import { parseModelOutput, RawFinding } from './parse';
import { buildReviewMessages, buildSynthesisMessages, PromptContext, REVIEW_JSON_SCHEMA } from './prompt';
import { FileDiff, Finding, Logger, ReviewResult, Severity, SEVERITIES, severityRank } from './types';

export interface ReviewOptions {
  llm: LlmClient;
  maxChunkChars: number;
  concurrency: number;
  minimumSeverity: Severity;
  exclude: (path: string) => boolean;
  context: Omit<PromptContext, 'chunkIndex' | 'chunkCount'>;
  log: Logger;
  signal?: AbortSignal;
  /** Progress callback; `increment` is a percentage of total work. */
  onProgress?: (message: string, increment?: number) => void;
  /** Files already skipped by the caller (e.g. too large), carried into the result. */
  preSkipped?: { path: string; reason: string }[];
}

export class CancelledError extends Error {
  constructor() {
    super('Review cancelled');
  }
}

/** Decide which files go to the model. */
export function selectFiles(
  files: FileDiff[],
  exclude: (p: string) => boolean,
): { included: FileDiff[]; skipped: { path: string; reason: string }[] } {
  const included: FileDiff[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const f of files) {
    if (f.binary) skipped.push({ path: f.path, reason: 'binary' });
    else if (f.status === 'deleted') skipped.push({ path: f.path, reason: 'deleted' });
    else if (exclude(f.path)) skipped.push({ path: f.path, reason: 'excluded by localCodeReview.excludeGlobs' });
    else if (!f.hunks.some((h) => h.lines.some((l) => l.kind === 'add'))) {
      skipped.push({ path: f.path, reason: f.status === 'renamed' ? 'pure rename' : 'no added lines' });
    } else included.push(f);
  }
  return { included, skipped };
}

export async function runReview(files: FileDiff[], opts: ReviewOptions): Promise<ReviewResult> {
  const started = Date.now();
  const { included, skipped } = selectFiles(files, opts.exclude);
  skipped.unshift(...(opts.preSkipped ?? []));
  const result: ReviewResult = {
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

  const chunks = chunkDiff(included, opts.maxChunkChars);
  result.chunkCount = chunks.length;
  opts.log.info(`Reviewing ${included.length} file(s) in ${chunks.length} chunk(s) with ${opts.llm.model}`);
  for (const s of skipped) opts.log.info(`  skipped ${s.path}: ${s.reason}`);

  const summaries: (string | undefined)[] = new Array(chunks.length);
  const findings: Finding[][] = new Array(chunks.length);
  let done = 0;
  const progressPerChunk = 100 / (chunks.length + (chunks.length > 1 ? 0.5 : 0));

  const work = async (i: number) => {
    if (opts.signal?.aborted) throw new CancelledError();
    const label = chunks.length > 1 ? `Part ${i + 1}/${chunks.length}` : 'Reviewing';
    try {
      const r = await reviewChunk(chunks[i], i, chunks.length, opts, (chars) =>
        opts.onProgress?.(`${label}: receiving… (${chars} chars, ${done}/${chunks.length} parts done)`),
      );
      summaries[i] = r.summary;
      findings[i] = r.findings;
    } catch (e) {
      if (opts.signal?.aborted) throw new CancelledError();
      const msg = `Part ${i + 1}/${chunks.length} (${chunks[i].files.map((f) => f.path).join(', ')}): ${(e as Error).message}`;
      opts.log.error(msg);
      result.errors.push(msg);
      findings[i] = [];
    }
    done++;
    opts.onProgress?.(`${done}/${chunks.length} parts done`, progressPerChunk);
  };

  await pool(chunks.length, Math.max(1, opts.concurrency), work);

  if (result.errors.length === chunks.length) {
    throw new LlmError(result.errors[0]);
  }

  const minRank = severityRank(opts.minimumSeverity);
  const all = dedupe(findings.flat()).filter((f) => severityRank(f.severity) <= minRank);
  all.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
  result.findings = all;
  const dropped = findings.flat().length - all.length;
  if (dropped > 0) opts.log.info(`Dropped ${dropped} finding(s) below '${opts.minimumSeverity}' severity or duplicated`);

  const partSummaries = summaries.filter((s): s is string => !!s?.trim());
  if (chunks.length > 1 && partSummaries.length > 1) {
    opts.onProgress?.('Writing overall summary…');
    try {
      const r = await opts.llm.chat(
        buildSynthesisMessages(
          opts.context.title,
          partSummaries,
          all.map((f) => `[${f.severity}] ${f.file}: ${f.title}`),
        ),
        { signal: opts.signal, schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
      );
      result.summary = parseModelOutput(r.content).summary?.trim() || partSummaries.join(' ');
    } catch (e) {
      if (opts.signal?.aborted) throw new CancelledError();
      opts.log.warn(`Summary synthesis failed: ${(e as Error).message}`);
      result.summary = partSummaries.join('\n\n');
    }
  } else {
    result.summary = partSummaries[0] ?? '';
  }
  result.durationMs = Date.now() - started;
  return result;
}

async function reviewChunk(
  chunk: Chunk,
  index: number,
  count: number,
  opts: ReviewOptions,
  onChars: (n: number) => void,
): Promise<{ summary?: string; findings: Finding[] }> {
  const messages = buildReviewMessages(chunk, { ...opts.context, chunkIndex: index, chunkCount: count });
  opts.log.debug(`--- prompt part ${index + 1}/${count} (${messages.map((m) => m.content.length).reduce((a, b) => a + b)} chars) ---`);
  let res = await opts.llm.chat(messages, { signal: opts.signal, schema: REVIEW_JSON_SCHEMA, onProgress: onChars });
  opts.log.debug(`--- raw model output part ${index + 1} ---\n${res.content}`);
  if (res.truncated) opts.log.warn(`Part ${index + 1}: output hit maxOutputTokens and was cut off; salvaging what parsed.`);

  let parsed = parseModelOutput(res.content);
  if (!parsed.ok) {
    opts.log.warn(`Part ${index + 1}: could not parse model output as JSON, asking once more.`);
    res = await opts.llm.chat(
      [
        ...messages,
        { role: 'assistant', content: res.content.slice(0, 4000) },
        { role: 'user', content: 'That was not valid JSON. Reply again with ONLY the JSON object described in the instructions.' },
      ],
      { signal: opts.signal, schema: REVIEW_JSON_SCHEMA, onProgress: onChars },
    );
    opts.log.debug(`--- raw model output part ${index + 1} (retry) ---\n${res.content}`);
    parsed = parseModelOutput(res.content);
    if (!parsed.ok) throw new Error('Model did not return parseable JSON (see the output channel for the raw reply)');
  }
  const findings = normalizeFindings(parsed.findings, chunk.files);
  return { summary: parsed.summary, findings };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  return '';
}

function toInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const m = /\d+/.exec(v);
    if (m) return parseInt(m[0], 10);
  }
  return undefined;
}

const SEVERITY_ALIASES: Record<string, Severity> = {
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

export function normalizeSeverity(v: unknown): Severity {
  const s = str(v).toLowerCase();
  if ((SEVERITIES as string[]).includes(s)) return s as Severity;
  return SEVERITY_ALIASES[s] ?? 'minor';
}

export function cleanPath(p: string): string {
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

function matchFile(name: string, files: FileDiff[]): FileDiff | undefined {
  if (!name) return files.length === 1 ? files[0] : undefined;
  const exact = files.find((f) => f.path === name);
  if (exact) return exact;
  const suffix = files.filter((f) => f.path.endsWith('/' + name) || name.endsWith('/' + f.path));
  if (suffix.length === 1) return suffix[0];
  const base = name.split('/').pop();
  const byBase = files.filter((f) => f.path.split('/').pop() === base);
  return byBase.length === 1 ? byBase[0] : undefined;
}

const SNAP_DISTANCE = 3;

/** Map a model-provided line range onto lines that are actually in the diff. */
export function mapLines(
  file: FileDiff,
  line: number | undefined,
  endLine: number | undefined,
): { line?: number; endLine?: number; inline: boolean; adjusted: boolean } {
  if (line === undefined || line < 1) return { inline: false, adjusted: false };
  const commentable = commentableLines(file);
  let l = line;
  let adjusted = false;
  if (!commentable.has(l)) {
    const added = addedLines(file);
    let best: number | undefined;
    for (let d = 1; d <= SNAP_DISTANCE && best === undefined; d++) {
      const cands = [l - d, l + d].filter((x) => commentable.has(x));
      best = cands.find((x) => added.has(x)) ?? cands[0];
    }
    if (best === undefined) return { line, endLine, inline: false, adjusted: false };
    l = best;
    adjusted = true;
  }
  let e: number | undefined = endLine;
  if (e !== undefined && (adjusted || e <= l || commentable.get(e) !== commentable.get(l))) e = undefined;
  if (e !== undefined) {
    for (let x = l; x <= e; x++) {
      if (!commentable.has(x)) {
        e = undefined;
        break;
      }
    }
  }
  return { line: l, endLine: e, inline: true, adjusted };
}

export function normalizeFindings(raw: RawFinding[], files: FileDiff[]): Finding[] {
  const out: Finding[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const body = str(r.body) || str(r.comment) || str(r.message) || str(r.description);
    let title = str(r.title);
    if (!title && !body) continue;
    if (!title) title = body.split(/(?<=[.!?])\s|\n/)[0].slice(0, 100);
    const name = cleanPath(str(r.file) || str(r.path));
    const file = matchFile(name, files);
    const severity = normalizeSeverity(r.severity);
    let suggestion = typeof r.suggestion === 'string' ? r.suggestion : undefined;
    if (suggestion) {
      const fence = /^```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(suggestion.trim());
      if (fence) suggestion = fence[1];
      if (!suggestion.trim()) suggestion = undefined;
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

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.file}|${f.line ?? ''}|${f.title.toLowerCase().replace(/\W+/g, ' ').trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function pool(n: number, concurrency: number, fn: (i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(n, concurrency) }, async () => {
    while (next < n) {
      const i = next++;
      await fn(i);
    }
  });
  await Promise.all(runners);
}
