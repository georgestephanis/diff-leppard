"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubClient = exports.GitHubError = exports.PROJECT_URL = void 0;
exports.webHostFromApiUrl = webHostFromApiUrl;
exports.parseRemoteUrl = parseRemoteUrl;
exports.parsePrReference = parsePrReference;
exports.formatCommentBody = formatCommentBody;
exports.buildReviewPayload = buildReviewPayload;
exports.attributionLine = attributionLine;
exports.postReview = postReview;
const diff_1 = require("./diff");
const markdown_1 = require("./markdown");
const types_1 = require("./types");
exports.PROJECT_URL = 'https://github.com/georgestephanis/diff-leppard';
class GitHubError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
    }
}
exports.GitHubError = GitHubError;
/** "https://api.github.com" -> "github.com"; "https://ghe.corp/api/v3" -> "ghe.corp". */
function webHostFromApiUrl(apiUrl) {
    const u = new URL(apiUrl);
    return u.hostname === 'api.github.com' ? 'github.com' : u.host;
}
/** Parse git@host:owner/repo.git, https://host/owner/repo(.git), ssh://git@host/owner/repo.git */
function parseRemoteUrl(url, host) {
    const h = host.replace(/[.]/g, '\\.');
    const patterns = [
        new RegExp(`^(?:[\\w.-]+@)?${h}:(?:/)?([^/]+)/(.+?)(?:\\.git)?/?$`),
        new RegExp(`^(?:https?|ssh|git)://(?:[^@/]+@)?${h}(?::\\d+)?/([^/]+)/(.+?)(?:\\.git)?/?$`),
    ];
    for (const re of patterns) {
        const m = re.exec(url.trim());
        if (m)
            return { owner: m[1], repo: m[2] };
    }
    return undefined;
}
/** Accepts "123", "#123", "owner/repo#123", or a PR URL. */
function parsePrReference(input, host, defaultRepo) {
    const s = input.trim();
    const h = host.replace(/[.]/g, '\\.');
    let m = new RegExp(`^(?:https?://)?${h}/([^/]+)/([^/]+)/pulls?/(\\d+)`).exec(s);
    if (m)
        return { repo: { owner: m[1], repo: m[2] }, number: parseInt(m[3], 10) };
    m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(s);
    if (m)
        return { repo: { owner: m[1], repo: m[2] }, number: parseInt(m[3], 10) };
    m = /^#?(\d+)$/.exec(s);
    if (m && defaultRepo)
        return { repo: defaultRepo, number: parseInt(m[1], 10) };
    return undefined;
}
class GitHubClient {
    apiUrl;
    token;
    log;
    constructor(apiUrl, token, log = types_1.nullLogger) {
        this.apiUrl = apiUrl;
        this.token = token;
        this.log = log;
    }
    async req(method, p, body, accept = 'application/vnd.github+json') {
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
                if (j.message)
                    msg += ` — ${j.message}`;
                if (Array.isArray(j.errors) && j.errors.length) {
                    msg += ` (${j.errors.map((e) => (typeof e === 'string' ? e : e.message ?? JSON.stringify(e))).join('; ')})`;
                }
            }
            catch {
                /* ignore */
            }
            if (res.status === 404)
                msg += ' (private repo? make sure the token has access)';
            throw new GitHubError(msg, res.status, text);
        }
        return res;
    }
    async getPull(r, n) {
        const j = (await (await this.req('GET', `/repos/${r.owner}/${r.repo}/pulls/${n}`)).json());
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
    async listOpenPulls(r) {
        const j = (await (await this.req('GET', `/repos/${r.owner}/${r.repo}/pulls?state=open&per_page=50&sort=updated&direction=desc`)).json());
        return j.map((p) => ({ number: p.number, title: p.title, author: p.user?.login ?? '', headRef: p.head?.ref ?? '', draft: !!p.draft }));
    }
    /** Changed files with their patches. Files GitHub won't return a patch for (too large/binary) are reported as skipped. */
    async getPullFiles(r, n) {
        const files = [];
        const skipped = [];
        for (let page = 1; page <= 30; page++) {
            const j = (await (await this.req('GET', `/repos/${r.owner}/${r.repo}/pulls/${n}/files?per_page=100&page=${page}`)).json());
            for (const f of j) {
                const status = f.status === 'added' ? 'added' : f.status === 'removed' ? 'deleted' : f.status === 'renamed' ? 'renamed' : 'modified';
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
                    hunks: (0, diff_1.parsePatchHunks)(f.patch),
                });
            }
            if (j.length < 100)
                break;
        }
        return { files, skipped };
    }
    async getFileContent(r, filePath, ref) {
        try {
            const res = await this.req('GET', `/repos/${r.owner}/${r.repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, undefined, 'application/vnd.github.raw+json');
            return await res.text();
        }
        catch (e) {
            if (e instanceof GitHubError && e.status === 404)
                return undefined;
            throw e;
        }
    }
    async createReview(r, n, payload) {
        const res = await this.req('POST', `/repos/${r.owner}/${r.repo}/pulls/${n}/reviews`, payload);
        return (await res.json());
    }
}
exports.GitHubClient = GitHubClient;
const SEVERITY_LABEL = {
    critical: '🔴 Critical',
    major: '🟠 Major',
    minor: '🟡 Minor',
    nit: '⚪ Nit',
};
function formatCommentBody(f, suggestionBlocks) {
    const head = `**${SEVERITY_LABEL[f.severity]}${f.category ? ` · ${f.category}` : ''}** — ${f.title}`;
    const parts = [head];
    if (f.body && f.body !== f.title)
        parts.push(f.body);
    if (f.suggestion) {
        const exact = f.inline && !f.lineAdjusted;
        parts.push(suggestionBlocks && exact ? (0, markdown_1.fence)(f.suggestion, 'suggestion') : `Suggested change:\n${(0, markdown_1.fence)(f.suggestion)}`);
    }
    return parts.join('\n\n');
}
function buildReviewPayload(result, pr, opts) {
    const inline = opts.forceAllInBody ? [] : result.findings.filter((f) => f.inline && f.line !== undefined);
    const other = result.findings.filter((f) => !inline.includes(f));
    const comments = inline.map((f) => {
        const c = { path: f.file, line: f.endLine ?? f.line, side: 'RIGHT', body: formatCommentBody(f, opts.suggestionBlocks) };
        if (f.endLine !== undefined && f.endLine > f.line) {
            c.start_line = f.line;
            c.start_side = 'RIGHT';
        }
        return c;
    });
    const body = [opts.attribution === false ? '## Code review' : '## 🐆 Diff Leppard code review', ''];
    if (result.summary)
        body.push(result.summary, '');
    body.push(`**Findings:** ${(0, markdown_1.countLine)(result.findings)}`);
    if (other.length) {
        body.push('', inline.length ? '### Other findings' : '### Findings', '');
        for (const f of other) {
            const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
            body.push(`<details><summary><b>${SEVERITY_LABEL[f.severity]}</b> ${escapeHtml(f.title)} — ${loc}</summary>`, '');
            body.push(formatCommentBody(f, false), '', '</details>', '');
        }
    }
    if (result.skippedFiles.length) {
        body.push('', `<sub>Not reviewed: ${result.skippedFiles.map((s) => `\`${s.path}\` (${s.reason})`).join(', ')}</sub>`);
    }
    if (result.errors.length) {
        body.push('', `<sub>⚠️ ${result.errors.length} part(s) of the diff could not be reviewed because the model request failed.</sub>`);
    }
    if (opts.attribution !== false)
        body.push('', attributionLine(result.model));
    const blocking = result.findings.some((f) => f.severity === 'critical' || f.severity === 'major');
    const payload = { commit_id: pr.headSha, body: body.join('\n'), comments };
    if (opts.event === 'COMMENT')
        payload.event = 'COMMENT';
    else if (opts.event === 'REQUEST_CHANGES_IF_BLOCKING')
        payload.event = blocking ? 'REQUEST_CHANGES' : 'COMMENT';
    // PENDING: omit event so GitHub creates a draft review.
    return payload;
}
/** Footer crediting the tool and model (on by default; `github.attribution: false` turns it off). */
function attributionLine(model) {
    return `<sub>Review generated by <a href="${exports.PROJECT_URL}">Diff Leppard</a>, running <code>${escapeHtml(model)}</code>. AI-generated — verify before acting.</sub>`;
}
function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/**
 * Post a review, falling back gracefully:
 *  - can't request changes on your own PR -> COMMENT
 *  - an inline comment GitHub can't place -> move every comment into the review body
 */
async function postReview(gh, repo, pr, result, opts, log = types_1.nullLogger) {
    const notes = [];
    let event = opts.event;
    let forceAllInBody = false;
    for (let attempt = 0; attempt < 3; attempt++) {
        const payload = buildReviewPayload(result, pr, { event, suggestionBlocks: opts.suggestionBlocks, forceAllInBody, attribution: opts.attribution });
        try {
            const r = await gh.createReview(repo, pr.number, payload);
            return { url: r.html_url ?? pr.htmlUrl, inlineCount: payload.comments.length, notes };
        }
        catch (e) {
            if (!(e instanceof GitHubError) || e.status !== 422)
                throw e;
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
