import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileDiffFromContent, parseUnifiedDiff } from './diff';
import { FileDiff } from './types';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function git(cwd: string, args: string[], allowFail = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotePath=false', ...args],
      { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        if (err && !allowFail) reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim() || err.message}`));
        else resolve(err ? '' : stdout);
      },
    );
  });
}

export async function getRepoRoot(dir: string): Promise<string | undefined> {
  const out = await git(dir, ['rev-parse', '--show-toplevel'], true);
  return out.trim() || undefined;
}

export async function getHeadSha(root: string): Promise<string | undefined> {
  const out = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], true);
  return out.trim() || undefined;
}

export async function getRemotes(root: string): Promise<{ name: string; url: string }[]> {
  const out = await git(root, ['remote', '-v'], true);
  const seen = new Set<string>();
  const remotes: { name: string; url: string }[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      remotes.push({ name: m[1], url: m[2] });
    }
  }
  return remotes;
}

export interface LocalDiffOptions {
  stagedOnly: boolean;
  contextLines: number;
  includeUntracked: boolean;
  /** Untracked files larger than this are skipped. */
  maxUntrackedBytes: number;
  exclude: (p: string) => boolean;
}

export interface LocalDiff {
  files: FileDiff[];
  skipped: { path: string; reason: string }[];
}

export async function getLocalDiff(root: string, opts: LocalDiffOptions): Promise<LocalDiff> {
  const base = (await getHeadSha(root)) ?? EMPTY_TREE;
  const common = ['diff', '--no-color', '--no-ext-diff', '--find-renames', `-U${opts.contextLines}`];
  const args = opts.stagedOnly ? [...common, '--cached', base] : [...common, base];
  const files = parseUnifiedDiff(await git(root, args));
  const skipped: { path: string; reason: string }[] = [];

  if (!opts.stagedOnly && opts.includeUntracked) {
    const out = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
    for (const rel of out.split('\0').filter(Boolean)) {
      if (opts.exclude(rel)) {
        skipped.push({ path: rel, reason: 'excluded by localCodeReview.excludeGlobs' });
        continue;
      }
      const abs = path.join(root, rel);
      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) continue;
        if (st.size > opts.maxUntrackedBytes) {
          skipped.push({ path: rel, reason: `untracked file larger than ${Math.round(opts.maxUntrackedBytes / 1024)} KB` });
          continue;
        }
        const buf = await fs.readFile(abs);
        if (buf.subarray(0, 8000).includes(0)) {
          skipped.push({ path: rel, reason: 'binary' });
          continue;
        }
        files.push(fileDiffFromContent(rel, buf.toString('utf8')));
      } catch (e) {
        skipped.push({ path: rel, reason: `unreadable: ${(e as Error).message}` });
      }
    }
  }
  return { files, skipped };
}

export async function readRepoFile(root: string, rel: string, maxChars = 8000): Promise<string | undefined> {
  try {
    const text = await fs.readFile(path.join(root, rel), 'utf8');
    return text.length > maxChars ? text.slice(0, maxChars) + '\n…[truncated]' : text;
  } catch {
    return undefined;
  }
}
