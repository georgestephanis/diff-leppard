"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ghExec = ghExec;
exports.githubTokenFor = githubTokenFor;
exports.githubRemotes = githubRemotes;
/** Shared GitHub CLI / remote helpers for the extension and the CLI (no `vscode` imports). */
const child_process_1 = require("child_process");
const git_1 = require("./git");
const github_1 = require("./github");
const GH_CANDIDATES = (env) => [env.GH_PATH || 'gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'];
function run(cmd, args, cwd) {
    return new Promise((resolve, reject) => (0, child_process_1.execFile)(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(Object.assign(new Error(stderr.trim() || err.message), { code: err.code })) : resolve(stdout.trim())));
}
/** Run the GitHub CLI, trying common install locations (GUI apps often lack Homebrew on PATH). */
async function ghExec(args, cwd, env = process.env) {
    let lastErr;
    for (const bin of GH_CANDIDATES(env)) {
        try {
            return await run(bin, args, cwd);
        }
        catch (e) {
            lastErr = e;
            if (e.code !== 'ENOENT')
                throw lastErr;
        }
    }
    throw new Error(`GitHub CLI (gh) not found: ${lastErr?.message}`);
}
/**
 * A GitHub token for `host`, following gh's own rules: GH_TOKEN / GITHUB_TOKEN only for github.com,
 * GH_ENTERPRISE_TOKEN / GITHUB_ENTERPRISE_TOKEN for other hosts, then `gh auth token --hostname host`.
 * Never hands a github.com token to another host.
 */
async function githubTokenFor(host, env = process.env) {
    const fromEnv = host === 'github.com' ? env.GH_TOKEN || env.GITHUB_TOKEN : env.GH_ENTERPRISE_TOKEN || env.GITHUB_ENTERPRISE_TOKEN;
    if (fromEnv)
        return fromEnv;
    try {
        const t = await ghExec(['auth', 'token', '--hostname', host], undefined, env);
        if (t)
            return t;
    }
    catch {
        /* fall through */
    }
    const envHint = host === 'github.com' ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN';
    throw new Error(`No GitHub token for ${host}. Set ${envHint}, or run "gh auth login --hostname ${host}".`);
}
/** GitHub repos among the git remotes, preferring `upstream` (fork workflow), then `origin`. */
async function githubRemotes(root, host) {
    if (!root)
        return [];
    const out = [];
    for (const r of await (0, git_1.getRemotes)(root)) {
        const repo = (0, github_1.parseRemoteUrl)(r.url, host);
        if (repo && !out.some((o) => o.repo.owner === repo.owner && o.repo.repo === repo.repo))
            out.push({ remote: r.name, repo });
    }
    const rank = (n) => (n === 'upstream' ? 0 : n === 'origin' ? 1 : 2);
    return out.sort((a, b) => rank(a.remote) - rank(b.remote));
}
