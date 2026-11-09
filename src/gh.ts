/** Shared GitHub CLI / remote helpers for the extension and the CLI (no `vscode` imports). */
import { execFile } from 'child_process';
import { getRemotes } from './git';
import { parseRemoteUrl, RepoRef } from './github';

const GH_CANDIDATES = (env: NodeJS.ProcessEnv) => [env.GH_PATH || 'gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'];

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(Object.assign(new Error(stderr.trim() || err.message), { code: (err as NodeJS.ErrnoException).code })) : resolve(stdout.trim()),
    ),
  );
}

/** Run the GitHub CLI, trying common install locations (GUI apps often lack Homebrew on PATH). */
export async function ghExec(args: string[], cwd?: string, env = process.env): Promise<string> {
  let lastErr: Error | undefined;
  for (const bin of GH_CANDIDATES(env)) {
    try {
      return await run(bin, args, cwd);
    } catch (e) {
      lastErr = e as Error;
      if ((e as { code?: string }).code !== 'ENOENT') throw lastErr;
    }
  }
  throw new Error(`GitHub CLI (gh) not found: ${lastErr?.message}`);
}

/**
 * A GitHub token for `host`, following gh's own rules: GH_TOKEN / GITHUB_TOKEN only for github.com,
 * GH_ENTERPRISE_TOKEN / GITHUB_ENTERPRISE_TOKEN for other hosts, then `gh auth token --hostname host`.
 * Never hands a github.com token to another host.
 */
export async function githubTokenFor(host: string, env = process.env): Promise<string> {
  const fromEnv =
    host === 'github.com' ? env.GH_TOKEN || env.GITHUB_TOKEN : env.GH_ENTERPRISE_TOKEN || env.GITHUB_ENTERPRISE_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const t = await ghExec(['auth', 'token', '--hostname', host], undefined, env);
    if (t) return t;
  } catch {
    /* fall through */
  }
  const envHint = host === 'github.com' ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN';
  throw new Error(`No GitHub token for ${host}. Set ${envHint}, or run "gh auth login --hostname ${host}".`);
}

/** GitHub repos among the git remotes, preferring `upstream` (fork workflow), then `origin`. */
export async function githubRemotes(root: string | undefined, host: string): Promise<{ remote: string; repo: RepoRef }[]> {
  if (!root) return [];
  const out: { remote: string; repo: RepoRef }[] = [];
  for (const r of await getRemotes(root)) {
    const repo = parseRemoteUrl(r.url, host);
    if (repo && !out.some((o) => o.repo.owner === repo.owner && o.repo.repo === repo.repo)) out.push({ remote: r.name, repo });
  }
  const rank = (n: string) => (n === 'upstream' ? 0 : n === 'origin' ? 1 : 2);
  return out.sort((a, b) => rank(a.remote) - rank(b.remote));
}
