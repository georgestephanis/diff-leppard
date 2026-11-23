"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultStateFile = defaultStateFile;
exports.readState = readState;
exports.writeState = writeState;
exports.acquireLock = acquireLock;
exports.watchQueries = watchQueries;
exports.repoMatches = repoMatches;
exports.clonePathFor = clonePathFor;
exports.prepareClone = prepareClone;
exports.watchOnce = watchOnce;
exports.parseInterval = parseInterval;
/**
 * `diff-leppard watch`: find open PRs that want your review across every repo you can access, review each
 * once per head commit with your model, and leave a review (a pending draft by default) for you to edit.
 * Runs on your machine (e.g. next to the model server), so the model never needs to be reachable from the
 * internet; it only makes outbound calls to GitHub.
 */
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const flow_1 = require("./flow");
const git_1 = require("./git");
const github_1 = require("./github");
const MAX_ATTEMPTS = 3;
const STATE_RETENTION_DAYS = 90;
function defaultStateFile(env = process.env) {
    const base = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    return path.join(base, 'diff-leppard', 'watch.json');
}
async function readState(file) {
    try {
        const j = JSON.parse(await fs_1.promises.readFile(file, 'utf8'));
        if (j && j.version === 1 && j.reviewed && typeof j.reviewed === 'object')
            return j;
    }
    catch {
        /* missing or unreadable: start fresh */
    }
    return { version: 1, reviewed: {} };
}
async function writeState(file, state) {
    const cutoff = Date.now() - STATE_RETENTION_DAYS * 86400_000;
    for (const [k, v] of Object.entries(state.reviewed))
        if (Date.parse(v.at) < cutoff)
            delete state.reviewed[k];
    await fs_1.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs_1.promises.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs_1.promises.rename(tmp, file);
}
/** Exclusive lock so overlapping runs (cron/timer + a slow review) don't double-review. */
async function acquireLock(file) {
    const lock = `${file}.lock`;
    await fs_1.promises.mkdir(path.dirname(lock), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fh = await fs_1.promises.open(lock, fs_1.constants.O_CREAT | fs_1.constants.O_EXCL | fs_1.constants.O_WRONLY);
            await fh.writeFile(String(process.pid));
            await fh.close();
            return () => fs_1.promises.rm(lock, { force: true });
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
            const pid = Number((await fs_1.promises.readFile(lock, 'utf8').catch(() => '')).trim());
            let alive = false;
            if (pid > 0) {
                try {
                    process.kill(pid, 0);
                    alive = true;
                }
                catch (err) {
                    alive = err.code === 'EPERM';
                }
            }
            if (alive)
                return undefined;
            await fs_1.promises.rm(lock, { force: true }); // stale lock from a crashed run
        }
    }
    return undefined;
}
/** The GitHub searches that make up "PRs that want my review". */
function watchQueries(w) {
    const base = `is:pr is:open archived:false${w.skipDrafts ? ' draft:false' : ''}`;
    const qs = [];
    if (w.reviewRequests === 'user')
        qs.push(`${base} user-review-requested:@me`);
    if (w.reviewRequests === 'team')
        qs.push(`${base} review-requested:@me`);
    if (w.ownPullRequests)
        qs.push(`${base} author:@me`);
    if (w.query.trim())
        qs.push(`${base} ${w.query.trim()}`);
    return qs;
}
function repoMatches(repo, patterns) {
    const name = `${repo.owner}/${repo.repo}`.toLowerCase();
    return patterns.some((p) => {
        const q = p.toLowerCase();
        return q.endsWith('/*') ? name.startsWith(q.slice(0, -1)) : name === q;
    });
}
/** The configured clone for a repo ("owner/repo" first, then "owner/*" + repo name), with ~ expanded. */
function clonePathFor(clones, repo) {
    const find = (k) => Object.entries(clones).find(([key]) => key.toLowerCase() === k.toLowerCase())?.[1];
    const exact = find(`${repo.owner}/${repo.repo}`);
    const dir = exact ? undefined : find(`${repo.owner}/*`);
    // GitHub forbids "." and ".." as repo names; check anyway, since the name comes from the API.
    if (!exact && dir && (!/^[\w.-]+$/.test(repo.repo) || /^\.\.?$/.test(repo.repo)))
        return undefined;
    const p = exact ?? (dir ? path.join(dir, repo.repo) : undefined);
    return p ? path.resolve(p.replace(/^~(?=$|[/\\])/, os.homedir())) : undefined;
}
/** git fetch that can't wait on a prompt or a stalled network: batch-mode ssh, a timeout, and abortable. */
function fetchQuietly(cwd, ownSsh, args, signal, timeoutMs = 5 * 60_000) {
    return new Promise((resolve, reject) => {
        (0, child_process_1.execFile)('git', args, {
            cwd,
            timeout: timeoutMs,
            signal,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(ownSsh ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }), LC_ALL: 'C' },
        }, (err, _out, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve()));
    });
}
const hasCommit = async (root, sha) => (await (0, git_1.git)(root, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], true)).trim() !== '';
/**
 * Make sure a local clone has a PR's head and base commits, fetching them from the clone's remote for the repo.
 * Only objects are fetched: no branch, tag or FETCH_HEAD changes, and nothing from the PR is run.
 * Returns the clone's path, or undefined (with a warning) when it can't be used.
 */
async function prepareClone(clone, repo, number, pr, host, log, signal) {
    const name = `${repo.owner}/${repo.repo}`;
    if (!(0, fs_1.existsSync)(clone)) {
        log.warn(`watch.clones: ${clone} doesn't exist; reviewing ${name}#${number} without it.`);
        return undefined;
    }
    // The clone itself (a worktree's top, or a bare repo), not a repo it happens to sit inside.
    const real = (p) => {
        try {
            return fs_1.realpathSync.native(p);
        }
        catch {
            return p;
        }
    };
    const bare = (await (0, git_1.git)(clone, ['rev-parse', '--is-bare-repository'], true)).trim() === 'true';
    const top = (await (0, git_1.git)(clone, ['rev-parse', bare ? '--absolute-git-dir' : '--show-toplevel'], true)).trim();
    if (!top || real(top) !== real(clone)) {
        log.warn(`watch.clones: ${clone} isn't the top of a git clone (or git refused it, e.g. safe.directory); reviewing ${name}#${number} without it.`);
        return undefined;
    }
    const want = [pr.headSha, pr.baseSha].filter((x) => !!x && /^[0-9a-f]{7,64}$/i.test(x));
    const missing = [];
    for (const sha of want)
        if (!(await hasCommit(clone, sha)))
            missing.push(sha);
    if (missing.length) {
        // The configured URLs, not `git remote -v`'s, which shows them after any url.<x>.insteadOf rewriting.
        const urls = (await (0, git_1.git)(clone, ['config', '--get-regexp', '^remote\\..*\\.url$'], true))
            .split('\n')
            .map((l) => /^remote\.(.+)\.url\s+(.+)$/.exec(l.trim()))
            .filter((m) => !!m)
            .map((m) => ({ name: m[1], url: m[2] }));
        const remote = urls.find((r) => {
            const ref = (0, github_1.parseRemoteUrl)(r.url, host);
            return ref && ref.owner.toLowerCase() === repo.owner.toLowerCase() && ref.repo.toLowerCase() === repo.repo.toLowerCase();
        });
        if (!remote) {
            log.warn(`watch.clones: ${clone} has no remote for ${host}/${name}; reviewing #${number} without it.`);
            return undefined;
        }
        // --refmap= stops git from also updating remote-tracking refs that match the remote's fetch refspecs
        // (e.g. a configured refs/pull/*/head:refs/remotes/origin/pr/*). Needs git 2.29+.
        // Never wait on an ssh prompt, unless the user chose their own ssh command (identity, agent).
        const ownSsh = !!(process.env.GIT_SSH_COMMAND || process.env.GIT_SSH || (await (0, git_1.git)(clone, ['config', 'core.sshCommand'], true)).trim());
        const fetch = (refs) => fetchQuietly(clone, ownSsh, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--refmap=', remote.name, ...refs], signal);
        try {
            await fetch([`refs/pull/${number}/head`]);
            // The base commit is usually an ancestor already; if not, fetch it by id (GitHub allows that).
            if (pr.baseSha && !(await hasCommit(clone, pr.baseSha)))
                await fetch([pr.baseSha]).catch(() => undefined);
        }
        catch (e) {
            if (signal?.aborted)
                throw e;
            log.warn(`watch.clones: fetching ${name}#${number} into ${clone} failed (${e.message}); reviewing without it.`);
            return undefined;
        }
        if (!(await hasCommit(clone, pr.headSha))) {
            log.warn(`watch.clones: ${clone} still lacks ${pr.headSha.slice(0, 7)} after fetching; reviewing ${name}#${number} without it.`);
            return undefined;
        }
    }
    return clone;
}
/** One pass: search, decide, review and post. */
async function watchOnce(o) {
    const w = o.settings.watch;
    const event = o.event ?? w.event;
    const summary = { candidates: 0, reviewed: 0, skipped: 0, failed: 0, deferred: 0 };
    const queries = watchQueries(w);
    if (!queries.length) {
        o.say('Nothing to watch: watch.reviewRequests is "off", watch.ownPullRequests is false and watch.query is empty.');
        return summary;
    }
    const found = new Map();
    for (const q of queries) {
        o.log.info(`search: ${q}`);
        for (const pr of await o.client.searchPullRequests(q))
            found.set(`${pr.repo.owner}/${pr.repo.repo}#${pr.number}`, pr);
    }
    const candidates = [...found.entries()].filter(([, pr]) => {
        if (w.repos.length && !repoMatches(pr.repo, w.repos))
            return false;
        if (w.excludeRepos.length && repoMatches(pr.repo, w.excludeRepos))
            return false;
        return true;
    });
    summary.candidates = candidates.length;
    const state = await readState(o.stateFile);
    for (const [key, hit] of candidates) {
        if (o.signal?.aborted)
            break;
        const prev = state.reviewed[key];
        // Cheap pre-check before fetching the PR: reviewed once already and not re-reviewing on push.
        if (prev && !prev.failures && !w.rereviewOnPush)
            continue;
        const pr = await o.client.getPull(hit.repo, hit.number);
        if (pr.state !== 'open' || (w.skipDrafts && pr.draft))
            continue;
        if (prev && prev.sha === pr.headSha && (!prev.failures || prev.failures >= MAX_ATTEMPTS))
            continue;
        if (summary.reviewed + summary.failed >= w.maxPerRun) {
            summary.deferred++;
            continue;
        }
        const short = pr.headSha.slice(0, 7);
        if (o.dryRun) {
            o.say(`would review ${key} @ ${short} — ${pr.title}`);
            summary.reviewed++;
            continue;
        }
        o.say(`reviewing ${key} @ ${short} — ${pr.title}`);
        try {
            const clone = clonePathFor(w.clones, hit.repo);
            const localRoot = clone ? await prepareClone(clone, hit.repo, hit.number, pr, o.host, o.log, o.signal) : undefined;
            const review = await (0, flow_1.reviewPullRequest)({
                client: o.client,
                repo: hit.repo,
                number: hit.number,
                host: o.host,
                settings: o.settings,
                configure: o.configure,
                localRoot,
                // A repo without a configured clone was warned about at startup; one whose clone failed was just warned about.
                noLocalClone: true,
                log: o.log,
                signal: o.signal,
                onProgress: o.onProgress,
                prefetched: pr,
            });
            if (review.result.errors.length)
                throw new Error(`review incomplete: ${review.result.errors.length} of ${review.result.chunkCount} part(s) failed`);
            const s = review.settings;
            try {
                const posted = await (0, github_1.postReview)(o.client, hit.repo, review.pr, review.result, { event, suggestionBlocks: s.github.suggestionBlocks, attribution: s.github.attribution }, o.log);
                state.reviewed[key] = { sha: pr.headSha, at: new Date().toISOString(), url: posted.url, findings: review.result.findings.length };
                o.say(`  ${event === 'PENDING' ? 'draft review ready' : 'review posted'}: ${review.result.findings.length} finding(s), ${posted.inlineCount} inline — ${posted.url}`);
                summary.reviewed++;
            }
            catch (e) {
                if (/pending review/i.test(e.message)) {
                    state.reviewed[key] = { sha: pr.headSha, at: new Date().toISOString(), skipped: 'you already have a pending review on this PR' };
                    o.say(`  skipped: you already have a pending review on ${key}; submit or delete it to get a new one`);
                    summary.skipped++;
                }
                else
                    throw e;
            }
        }
        catch (e) {
            if (o.signal?.aborted)
                break;
            const failures = (prev?.sha === pr.headSha ? (prev.failures ?? 0) : 0) + 1;
            state.reviewed[key] = { sha: pr.headSha, at: new Date().toISOString(), failures };
            o.say(`  failed (${failures}/${MAX_ATTEMPTS}): ${e.message}${failures >= MAX_ATTEMPTS ? ' — giving up on this commit' : ''}`);
            summary.failed++;
        }
        await writeState(o.stateFile, state);
    }
    return summary;
}
/** "5m", "90s", "1h", or a bare number of minutes → milliseconds. */
function parseInterval(s) {
    const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(s.trim());
    if (!m)
        throw new Error(`--interval must look like 30s, 5m or 1h (got "${s}")`);
    const n = parseFloat(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 'm').toLowerCase()];
    if (n < 30_000)
        throw new Error('--interval must be at least 30s (GitHub search is rate limited)');
    return n;
}
