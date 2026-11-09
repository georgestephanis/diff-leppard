import { parsePatchHunks } from './diff';
import { countLine, fence } from './markdown';
import { FileDiff, FileStatus, Finding, Logger, ReviewResult, Severity, nullLogger } from './types';

export const PROJECT_URL = 'https://github.com/georgestephanis/diff-leppard';

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
  headRef: string;
  htmlUrl: string;
  author: string;
  state: string;
  draft: boolean;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

/** "https://api.github.com" -> "github.com"; "https://ghe.corp/api/v3" -> "ghe.corp". */
export function webHostFromApiUrl(apiUrl: string): string {
  const u = new URL(apiUrl);
  return u.hostname === 'api.github.com' ? 'github.com' : u.host;
}

/** Parse git@host:owner/repo.git, https://host/owner/repo(.git), ssh://git@host/owner/repo.git */
export function parseRemoteUrl(url: string, host: string): RepoRef | undefined {
  const h = host.replace(/[.]/g, '\\.');
  const patterns = [
    new RegExp(`^(?:[\\w.-]+@)?${h}:(?:/)?([^/]+)/(.+?)(?:\\.git)?/?$`),
    new RegExp(`^(?:https?|ssh|git)://(?:[^@/]+@)?${h}(?::\\d+)?/([^/]+)/(.+?)(?:\\.git)?/?$`),
  ];
  for (const re of patterns) {
    const m = re.exec(url.trim());
    if (m) return { owner: m[1], repo: m[2] };
  }
  return undefined;
}

/** Accepts "123", "#123", "owner/repo#123", or a PR URL. */
export function parsePrReference(input: string, host: string, defaultRepo?: RepoRef): { repo: RepoRef; number: number } | undefined {
  const s = input.trim();
  const h = host.replace(/[.]/g, '\\.');
  let m = new RegExp(`^(?:https?://)?${h}/([^/]+)/([^/]+)/pulls?/(\\d+)`).exec(s);
  if (m) return { repo: { owner: m[1], repo: m[2] }, number: parseInt(m[3], 10) };
  m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(s);
  if (m) return { repo: { owner: m[1], repo: m[2] }, number: parseInt(m[3], 10) };
  m = /^#?(\d+)$/.exec(s);
  if (m && defaultRepo) return { repo: defaultRepo, number: parseInt(m[1], 10) };
  return undefined;
}

export class GitHubClient {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
    private readonly log: Logger = nullLogger,
  ) {}

  private async req(method: string, p: string, body?: unknown, accept = 'application/vnd.github+json'): Promise<Response> {
    const url = `${this.apiUrl.replace(/\/+$/, '')}${p}`;
    this.log.debug(`GitHub ${method} ${url}`);
    const res = await fetch(url, {
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'diff-leppard',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = `GitHub ${method} ${p} failed: ${res.status} ${res.statusText}`;
      try {
        const j = JSON.parse(text);
        if (j.message) msg += ` — ${j.message}`;
        if (Array.isArray(j.errors) && j.errors.length) {
          msg += ` (${j.errors.map((e: unknown) => (typeof e === 'string' ? e : (e as { message?: string }).message ?? JSON.stringify(e))).join('; ')})`;
        }
      } catch {
        /* ignore */
      }
      if (res.status === 404) msg += ' (private repo? make sure the token has access)';
      throw new GitHubError(msg, res.status, text);
    }
    return res;
  }

  async getPull(r: RepoRef, n: number): Promise<PullRequestInfo> {
    const j = (await (await this.req('GET', `/repos/${r.owner}/${r.repo}/pulls/${n}`)).json()) as any;
    return {
      number: j.number,
      title: j.title ?? '',
      body: j.body ?? '',
      headSha: j.head?.sha,
      baseSha: j.base?.sha,
      baseRef: j.base?.ref,
      headRef: j.head?.ref,
      htmlUrl: j.html_url,
      author: j.user?.login ?? '',
      state: j.state,
      draft: !!j.draft,
    };
  }

  async listOpenPulls(r: RepoRef): Promise<{ number: number; title: string; author: string; headRef: string; draft: boolean }[]> {
    const j = (await (await this.req('GET', `/repos/${r.owner}/${r.repo}/pulls?state=open&per_page=50&sort=updated&direction=desc`)).json()) as any[];
    return j.map((p) => ({ number: p.number, title: p.title, author: p.user?.login ?? '', headRef: p.head?.ref ?? '', draft: !!p.draft }));
  }

  /** Changed files with their patches. Files GitHub won't return a patch for (too large/binary) are reported as skipped. */
  async getPullFiles(r: RepoRef, n: number): Promise<{ files: FileDiff[]; skipped: { path: string; reason: string }[] }> {
    const files: FileDiff[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (let page = 1; page <= 30; page++) {
      const j = (await (await this.req('GET', `/repos/${r.owner}/${r.repo}/pulls/${n}/files?per_page=100&page=${page}`)).json()) as any[];
      for (const f of j) {
        const status: FileStatus =
          f.status === 'added' ? 'added' : f.status === 'removed' ? 'deleted' : f.status === 'renamed' ? 'renamed' : 'modified';
        if (typeof f.patch !== 'string') {
          if (status !== 'deleted' && !(status === 'renamed' && f.changes === 0)) {
            skipped.push({ path: f.filename, reason: 'GitHub did not return a patch (binary or too large)' });
          }
          continue;
        }
        files.push({
          path: f.filename,
          oldPath: f.previous_filename,
          status,
          binary: false,
          hunks: parsePatchHunks(f.patch),
        });
      }
      if (j.length < 100) break;
    }
    return { files, skipped };
  }

  /** Pull requests matching a GitHub search query (`is:pr` is added). Most recently updated first. */
  async searchPullRequests(query: string, limit = 100): Promise<{ repo: RepoRef; number: number; title: string; url: string; draft: boolean; author: string }[]> {
    const q = /\bis:pr\b/.test(query) ? query : `is:pr ${query}`;
    const out: { repo: RepoRef; number: number; title: string; url: string; draft: boolean; author: string }[] = [];
    for (let page = 1; out.length < limit && page <= 10; page++) {
      const j = (await (await this.req('GET', `/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=50&page=${page}`)).json()) as any;
      for (const it of j.items ?? []) {
        const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(it.repository_url ?? '');
        if (m) out.push({ repo: { owner: m[1], repo: m[2] }, number: it.number, title: it.title ?? '', url: it.html_url, draft: !!it.draft, author: it.user?.login ?? '' });
      }
      if ((j.items ?? []).length < 50) break;
    }
    return out.slice(0, limit);
  }

  async getFileContent(r: RepoRef, filePath: string, ref: string): Promise<string | undefined> {
    try {
      const res = await this.req(
        'GET',
        `/repos/${r.owner}/${r.repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
        undefined,
        'application/vnd.github.raw+json',
      );
      return await res.text();
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return undefined;
      throw e;
    }
  }

  async createReview(r: RepoRef, n: number, payload: ReviewPayload): Promise<{ id: number; html_url: string; state: string }> {
    const res = await this.req('POST', `/repos/${r.owner}/${r.repo}/pulls/${n}/reviews`, payload);
    return (await res.json()) as { id: number; html_url: string; state: string };
  }
}

// ---------------------------------------------------------------------------
// Review payload
// ---------------------------------------------------------------------------

export type ReviewEventSetting = 'COMMENT' | 'REQUEST_CHANGES_IF_BLOCKING' | 'PENDING';

export interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  start_line?: number;
  start_side?: 'RIGHT';
  body: string;
}

export interface ReviewPayload {
  commit_id: string;
  body: string;
  event?: 'COMMENT' | 'REQUEST_CHANGES';
  comments: ReviewComment[];
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: '🔴 Critical',
  major: '🟠 Major',
  minor: '🟡 Minor',
  nit: '⚪ Nit',
};

export function formatCommentBody(f: Finding, suggestionBlocks: boolean): string {
  const head = `**${SEVERITY_LABEL[f.severity]}${f.category ? ` · ${f.category}` : ''}** — ${f.title}`;
  const parts = [head];
  if (f.body && f.body !== f.title) parts.push(f.body);
  if (f.suggestion) {
    const exact = f.inline && !f.lineAdjusted;
    parts.push(suggestionBlocks && exact ? fence(f.suggestion, 'suggestion') : `Suggested change:\n${fence(f.suggestion)}`);
  }
  return parts.join('\n\n');
}

export function buildReviewPayload(
  result: ReviewResult,
  pr: { headSha: string },
  opts: { event: ReviewEventSetting; suggestionBlocks: boolean; forceAllInBody?: boolean; attribution?: boolean },
): ReviewPayload {
  const inline = opts.forceAllInBody ? [] : result.findings.filter((f) => f.inline && f.line !== undefined);
  const other = result.findings.filter((f) => !inline.includes(f));

  const comments: ReviewComment[] = inline.map((f) => {
    const c: ReviewComment = { path: f.file, line: f.endLine ?? f.line!, side: 'RIGHT', body: formatCommentBody(f, opts.suggestionBlocks) };
    if (f.endLine !== undefined && f.endLine > f.line!) {
      c.start_line = f.line;
      c.start_side = 'RIGHT';
    }
    return c;
  });

  const body: string[] = [opts.attribution === false ? '## Code review' : '## 🐆 Diff Leppard code review', ''];
  if (result.summary) body.push(result.summary, '');
  body.push(`**Findings:** ${countLine(result.findings)}`);
  if (other.length) {
    body.push('', inline.length ? '### Other findings' : '### Findings', '');
    for (const f of other) {
      const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      body.push(`<details><summary><b>${SEVERITY_LABEL[f.severity]}</b> ${escapeHtml(f.title)} — ${loc}</summary>`, '');
      body.push(formatCommentBody(f, false), '', '</details>', '');
    }
  }
  if (result.skippedFiles.length) {
    body.push('', `<sub>Not reviewed: ${summarizeSkipped(result.skippedFiles)}</sub>`);
  }
  if (result.errors.length) {
    body.push('', `<sub>⚠️ ${result.errors.length} part(s) of the diff could not be reviewed because the model request failed.</sub>`);
  }
  if (opts.attribution !== false) body.push('', attributionLine(result.model));

  const blocking = result.findings.some((f) => f.severity === 'critical' || f.severity === 'major');
  const payload: ReviewPayload = { commit_id: pr.headSha, body: body.join('\n'), comments };
  if (opts.event === 'COMMENT') payload.event = 'COMMENT';
  else if (opts.event === 'REQUEST_CHANGES_IF_BLOCKING') payload.event = blocking ? 'REQUEST_CHANGES' : 'COMMENT';
  // PENDING: omit event so GitHub creates a draft review.
  return payload;
}

/** "`a.js` (binary); 16 files excluded by excludeGlobs (`dist/cli.js`, `dist/config.js`, … +14 more)" */
export function summarizeSkipped(skipped: { path: string; reason: string }[], listUpTo = 3): string {
  const byReason = new Map<string, string[]>();
  for (const s of skipped) {
    if (!byReason.has(s.reason)) byReason.set(s.reason, []);
    byReason.get(s.reason)!.push(s.path);
  }
  return [...byReason]
    .map(([reason, paths]) => {
      if (paths.length === 1) return `\`${paths[0]}\` (${reason})`;
      const shown = paths.slice(0, listUpTo).map((p) => `\`${p}\``);
      const more = paths.length > listUpTo ? `, … +${paths.length - listUpTo} more` : '';
      return `${paths.length} files ${reason} (${shown.join(', ')}${more})`;
    })
    .join('; ');
}

/** Footer crediting the tool and model (on by default; `github.attribution: false` turns it off). */
export function attributionLine(model: string): string {
  return `<sub>Review generated by <a href="${PROJECT_URL}">Diff Leppard</a>, running <code>${escapeHtml(model)}</code>. AI-generated — verify before acting.</sub>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Post a review, falling back gracefully:
 *  - can't request changes on your own PR -> COMMENT
 *  - an inline comment GitHub can't place -> move every comment into the review body
 */
export async function postReview(
  gh: GitHubClient,
  repo: RepoRef,
  pr: PullRequestInfo,
  result: ReviewResult,
  opts: { event: ReviewEventSetting; suggestionBlocks: boolean; attribution?: boolean },
  log: Logger = nullLogger,
): Promise<{ url: string; inlineCount: number; notes: string[] }> {
  const notes: string[] = [];
  let event = opts.event;
  let forceAllInBody = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const payload = buildReviewPayload(result, pr, { event, suggestionBlocks: opts.suggestionBlocks, forceAllInBody, attribution: opts.attribution });
    try {
      const r = await gh.createReview(repo, pr.number, payload);
      return { url: r.html_url ?? pr.htmlUrl, inlineCount: payload.comments.length, notes };
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 422) throw e;
      log.warn(e.message);
      if (/own pull request/i.test(e.body) && payload.event === 'REQUEST_CHANGES') {
        notes.push("GitHub doesn't allow requesting changes on your own PR, so it was posted as a comment review.");
        event = 'COMMENT';
        continue;
      }
      if (/pending review/i.test(e.body)) {
        throw new Error('You already have a pending review on this PR. Submit or delete it on GitHub, then post again.');
      }
      if (!forceAllInBody && payload.comments.length) {
        notes.push('GitHub rejected some inline comment positions, so all findings were put in the review body instead.');
        forceAllInBody = true;
        continue;
      }
      throw e;
    }
  }
  throw new Error('Could not post review');
}
