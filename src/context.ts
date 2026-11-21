/**
 * Extra context for a review, beyond the diff hunks: the changed files' surrounding code (up to the whole
 * file), related code elsewhere in the repo, and the project's agent/contributor guide. Everything here is
 * sized from one budget, the characters the model's context window leaves for the prompt, so a bigger
 * context window buys more context and a small one degrades gracefully to plain hunks.
 *
 * No `vscode` imports.
 */
import { contentMatchesDiff } from './diff';
import { git } from './git';
import { GitHubClient, RepoRef } from './github';
import { FileDiff, Logger } from './types';

// ---------------------------------------------------------------------------
// Reading the reviewed revision
// ---------------------------------------------------------------------------

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

/** Read-only access to the repository as of the reviewed revision. */
export interface RepoView {
  /** Short description for logs, e.g. "git abc1234" or "working tree". */
  describe: string;
  /** A file's text, or undefined if it doesn't exist, is binary, or is larger than maxBytes. */
  read(path: string, maxBytes?: number): Promise<string | undefined>;
  /** Fixed-string search; undefined when this view can't search. */
  grep?(needles: string[], maxHits: number): Promise<GrepHit[]>;
  /** Files under a directory (recursive, repo-relative); undefined when not a directory or not supported. */
  list?(dir: string, max: number): Promise<string[] | undefined>;
  /** The last commit that touched a path, as "<sha> <date> <subject>". */
  lastChange?(path: string): Promise<string | undefined>;
}

const DEFAULT_MAX_READ = 512 * 1024;

/** No path from the model or a diff may climb out of the repo or name git internals. */
export function safeRepoPath(p: string): string | undefined {
  const clean = p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!clean || clean.startsWith('/') || clean.startsWith('-') || /^[A-Za-z]:/.test(clean)) return undefined;
  const parts = clean.split('/');
  if (parts.some((x) => x === '..' || x === '.git' || x === '')) return undefined;
  return clean;
}

/** Pass as `rev` to gitRepoView for the index (staged content), like `git show :path`. */
export const INDEX = ':';

/**
 * A view of a local git repository: at `rev` (a commit), the index (INDEX), or, with no rev, the working tree.
 * Reads go through git (`git show rev:path`, or the index/working tree via `git ls-files`), so nothing
 * outside the repository's tracked or untracked-but-not-ignored files is ever read.
 */
export function gitRepoView(root: string, rev?: string): RepoView {
  const tracked = async (p: string) => (await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '--', p], true)).split('\n').filter(Boolean);
  return {
    describe: rev === INDEX ? 'git index' : rev ? `git ${rev.slice(0, 12)}` : 'working tree',
    async read(p, maxBytes = DEFAULT_MAX_READ) {
      const safe = safeRepoPath(p);
      if (!safe) return undefined;
      let text: string;
      if (rev) {
        const spec = rev === INDEX ? `:${safe}` : `${rev}:${safe}`;
        const size = parseInt((await git(root, ['cat-file', '-s', spec], true)).trim(), 10);
        if (!(size >= 0) || size > maxBytes) return undefined;
        const type = (await git(root, ['cat-file', '-t', spec], true)).trim();
        if (type !== 'blob') return undefined;
        text = await git(root, ['cat-file', 'blob', spec], true);
      } else {
        // Only files git would show (tracked, or untracked and not ignored): never a symlink out of the repo.
        if (!(await tracked(safe)).includes(safe)) return undefined;
        const { promises: fs } = await import('fs');
        const path = await import('path');
        try {
          const abs = path.join(root, safe);
          const st = await fs.lstat(abs);
          if (!st.isFile() || st.size > maxBytes) return undefined;
          text = await fs.readFile(abs, 'utf8');
        } catch {
          return undefined;
        }
      }
      if (text.slice(0, 8000).includes('\0')) return undefined;
      return text;
    },
    async grep(needles, maxHits) {
      const uniq = [...new Set(needles.filter((n) => n && !n.startsWith('-') && !n.includes('\n')))];
      if (!uniq.length) return [];
      const args = ['grep', '-n', '-I', '-F', '-z', '--full-name', '--no-color', '-m', '5'];
      for (const n of uniq) args.push('-e', n);
      if (rev === INDEX) args.push('--cached');
      else if (rev) args.push(rev);
      else args.push('--untracked');
      args.push('--');
      const out = await git(root, args, true);
      const hits: GrepHit[] = [];
      const prefix = rev && rev !== INDEX ? `${rev}:` : '';
      for (const row of out.split('\n')) {
        if (!row) continue;
        const [p, ln, ...rest] = row.split('\0');
        const line = parseInt(ln, 10);
        if (!p || !(line > 0)) continue;
        hits.push({ path: p.startsWith(prefix) ? p.slice(prefix.length) : p, line, text: rest.join('\0') });
        if (hits.length >= maxHits) break;
      }
      return hits;
    },
    async lastChange(p) {
      const safe = safeRepoPath(p);
      if (!safe) return undefined;
      const out = await git(root, ['log', '-1', '--format=%h %ad %s', '--date=short', ...(rev && rev !== INDEX ? [rev] : []), '--', safe], true);
      return out.trim() || undefined;
    },
    async list(dir, max) {
      const safe = safeRepoPath(dir);
      if (!safe) return undefined;
      const out = rev === INDEX
        ? await git(root, ['ls-files', '--cached', '--', `${safe}/`], true)
        : rev
        ? await git(root, ['ls-tree', '-r', '--name-only', rev, '--', `${safe}/`], true)
        : (await tracked(`${safe}/`)).join('\n');
      const files = out.split('\n').filter(Boolean);
      return files.length ? files.slice(0, max) : undefined;
    },
  };
}

/** A view through the GitHub contents API (reads only; no search). Used for PRs without a local checkout. */
export function githubRepoView(client: GitHubClient, repo: RepoRef, sha: string): RepoView {
  return {
    describe: `GitHub ${repo.owner}/${repo.repo}@${sha.slice(0, 12)}`,
    async read(p, maxBytes = DEFAULT_MAX_READ) {
      const safe = safeRepoPath(p);
      if (!safe) return undefined;
      const text = await client.getFileContent(repo, safe, sha).catch(() => undefined);
      if (text === undefined || text.length > maxBytes || text.slice(0, 8000).includes('\0')) return undefined;
      return text;
    },
  };
}

/** A local checkout that has `sha`, as a view at that commit; undefined if there's no such checkout. */
export async function localViewAt(root: string | undefined, sha: string | undefined): Promise<RepoView | undefined> {
  if (!root || !sha || !/^[0-9a-f]{7,64}$/i.test(sha)) return undefined;
  const ok = (await git(root, ['cat-file', '-e', `${sha}^{commit}`], true)) !== undefined;
  const exists = ok && (await git(root, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], true)).trim();
  return exists ? gitRepoView(root, sha) : undefined;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface ContextSettings {
  /** Send a changed file whole when its new version is at most this many characters (0 = never). */
  fullFileMaxChars: number;
  /** Characters of related code from elsewhere in the repo per request (0 = off). */
  relatedMaxChars: number;
  /** Characters of project guidelines (instructions file / AGENTS.md …). */
  maxInstructionsChars: number;
}

/**
 * Split one request's character budget (from the model's context window, see resolveChunkChars) between
 * guidelines, related code and the diff itself. Caps from settings are upper bounds; with a small
 * context window everything shrinks so the diff always keeps most of the room.
 */
export function planBudget(total: number, s: ContextSettings): { instructions: number; related: number; fullFile: number } {
  const instructions = Math.min(s.maxInstructionsChars, Math.floor(total * 0.15));
  const related = Math.min(s.relatedMaxChars, Math.floor(total * 0.2));
  const diff = total - instructions - related;
  const fullFile = Math.min(s.fullFileMaxChars, Math.floor(diff * 0.8));
  return { instructions, related, fullFile: fullFile > 0 ? fullFile : 0 };
}

// ---------------------------------------------------------------------------
// Whole files / widened hunks
// ---------------------------------------------------------------------------

/** Load the new version of each changed file (for whole-file or widened-context rendering). */
export async function attachFileContents(
  files: FileDiff[],
  view: RepoView,
  maxChars: number,
  log: Logger,
  exclude: (p: string) => boolean = () => false,
): Promise<void> {
  if (maxChars <= 0) return;
  let n = 0;
  // An added file's hunk is already the whole file; excluded files aren't reviewed.
  const todo = files.filter((f) => !f.binary && f.status !== 'deleted' && f.status !== 'added' && !exclude(f.path));
  let next = 0;
  // At most 4 reads at a time: through the GitHub API each one is a request.
  await Promise.all(
    Array.from({ length: Math.min(4, todo.length) }, async () => {
      while (next < todo.length) {
        const f = todo[next++];
        // Read a little more than the budget: widened context still helps when the whole file doesn't fit.
        const text = await view.read(f.path, maxChars * 8).catch(() => undefined);
        if (text === undefined) continue;
        if (!contentMatchesDiff(f, text)) {
          log.debug(`context: ${f.path} at ${view.describe} doesn't match the diff; using hunks only`);
          continue;
        }
        f.content = text;
        n++;
      }
    }),
  );
  if (n) log.info(`context: loaded ${n} changed file(s) from ${view.describe} for surrounding code`);
}

// ---------------------------------------------------------------------------
// Related code
// ---------------------------------------------------------------------------

export interface RelatedSnippet {
  path: string;
  /** Why it was included, e.g. "uses .bg-full-width" or "folder named in the change". */
  reason: string;
  text: string;
  /** Lower = more relevant. */
  rank: number;
}

const STOP = new Set(
  'this that with from return function class const let var true false null none self else elif then while for each into when what where which there their have will would should could import export default async await static public private protected string number boolean object array value values items item data type types name names index length error errors result results options config props state value test tests main http https width height color display block inline none auto flex grid content'.split(
    ' ',
  ),
);

/** Identifiers from the changed lines worth searching for elsewhere. Most specific first. */
export function extractIdentifiers(f: FileDiff): { needles: string[]; paths: string[] } {
  const changed = f.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== 'ctx').map((l) => l.text));
  const text = changed.join('\n');
  const out = new Map<string, number>();
  const add = (s: string, weight: number) => {
    if (s.length < 4 || STOP.has(s.toLowerCase())) return;
    out.set(s, Math.max(out.get(s) ?? 0, weight + Math.min(s.length, 30) / 10));
  };
  const isStyle = /\.(css|scss|sass|less|html?|vue|svelte|jsx|tsx|hbs|njk|liquid|twig|php|erb)$/i.test(f.path);
  let m: RegExpExecArray | null;
  // Definitions: function/class/def names.
  const defRe = /\b(?:function|def|class|interface|type|enum|func|fn|sub|macro)\s+([A-Za-z_$][\w$]{3,})/g;
  while ((m = defRe.exec(text))) add(m[1], 5);
  const assignRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]{4,})\s*=\s*(?:async\s*)?(?:function|\(|[A-Za-z_$][\w$]*\s*=>)/g;
  while ((m = assignRe.exec(text))) add(m[1], 4);
  // CLI flags and environment variables / constants.
  const flagRe = /(?<![\w-])(--[a-z][\w-]{2,})/g;
  while ((m = flagRe.exec(text))) add(m[1], 4);
  const envRe = /\b([A-Z][A-Z0-9]*_[A-Z0-9_]{2,})\b/g;
  while ((m = envRe.exec(text))) add(m[1], 3);
  if (isStyle) {
    // CSS classes from selectors and class attributes (only multi-part names: "btn" is everywhere).
    const clsRe = /(?:^|[\s,>+~(])\.([a-zA-Z][\w-]*-[\w-]+)/gm;
    while ((m = clsRe.exec(text))) add('.' + m[1], 3);
    const attrRe = /class(?:Name)?=["'{]([^"'}]+)/g;
    while ((m = attrRe.exec(text))) for (const c of m[1].split(/\s+/)) if (/^[a-zA-Z][\w]*-[\w-]+$/.test(c)) add(c, 2);
  }
  // Paths: from the changed lines first, then from the rest of the file (a default directory is often set
  // once at the top). Callers check that they exist.
  const isDoc = /\.(md|mdx|rst|txt|adoc)$/i.test(f.path);
  const paths = [...new Set([...extractPaths(text), ...(f.content && !isDoc ? extractPaths(f.content) : [])])];
  const needles = [...out.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return { needles: needles.slice(0, 12), paths: paths.slice(0, 12) };
}

/** Repo-relative path candidates in text: quoted paths, joined segments ("a" / "b", join('a', 'b')) and bare a/b/c. */
export function extractPaths(text: string): string[] {
  const found: string[] = [];
  const push = (raw: string) => {
    if (/^[a-z][\w+.-]*:\/\//i.test(raw) || raw.startsWith('//')) return;
    // Drop globs and trailing file patterns: data/x/*.json -> data/x
    const cut = raw.replace(/\/?[^/]*[*?{[][^/]*$/, '').replace(/^\.\//, '');
    const p = safeRepoPath(cut);
    if (p && p.includes('/') && !found.includes(p)) found.push(p);
  };
  let m: RegExpExecArray | null;
  const quoted = /["'`]((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.*-]+)+\/?)["'`]/g;
  while ((m = quoted.exec(text))) push(m[1]);
  // "data" / "x" / "y"   or   join("data", "x", "y")
  const seg = `["']([\\w@.-]+)["']`;
  const joined = new RegExp(`${seg}(?:\\s*(?:/|,)\\s*${seg})+`, 'g');
  while ((m = joined.exec(text))) {
    const parts = m[0].match(/["']([\w@.-]+)["']/g)!.map((x) => x.slice(1, -1));
    if (parts.length >= 2 && parts.every((x) => !/^\.+$/.test(x))) push(parts.join('/'));
  }
  const bare = /(?<![\w@:/.-])((?:[\w@-][\w@.-]*\/){1,}[\w@.*-]+)\/?(?![\w(])/g;
  while ((m = bare.exec(text))) if (/[a-z]/i.test(m[1]) && !/^\d/.test(m[1])) push(m[1]);
  return found;
}

const DOC_RE = /(^|\/)(README|CONTRIBUTING|ARCHITECTURE|AGENTS|CLAUDE)[^/]*$|\.(md|mdx|rst|txt|adoc)$/i;
const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+$/i;

function snippetAround(lines: string[], hit: number, before: number, after: number): string {
  const a = Math.max(1, hit - before);
  const b = Math.min(lines.length, hit + after);
  const width = Math.max(4, String(b).length);
  const out: string[] = [];
  for (let i = a; i <= b; i++) out.push(`${String(i).padStart(width)}   ${lines[i - 1]}`);
  return out.join('\n');
}

/** The nearest README at or above `dir` (not the repo root's: that one is usually generic). */
async function nearestReadme(view: RepoView, dir: string): Promise<{ path: string; text: string } | undefined> {
  const parts = dir.split('/');
  for (let i = parts.length; i >= 1; i--) {
    const d = parts.slice(0, i).join('/');
    for (const name of ['README.md', 'README', 'readme.md', 'README.txt']) {
      const t = await view.read(`${d}/${name}`, 64 * 1024).catch(() => undefined);
      if (t !== undefined) return { path: `${d}/${name}`, text: t };
    }
  }
  return undefined;
}

/**
 * Cheap retrieval, no model calls: search the repo for identifiers the change touches, and look at
 * folders the change names. Returns snippets ranked most relevant first, keyed by changed file.
 */
export async function findRelatedCode(
  files: FileDiff[],
  view: RepoView,
  opts: { exclude: (p: string) => boolean; log: Logger; maxPerFile?: number },
): Promise<Map<string, RelatedSnippet[]>> {
  const result = new Map<string, RelatedSnippet[]>();
  const changed = new Set(files.map((f) => f.path));
  const fileCache = new Map<string, string[] | undefined>();
  const linesOf = async (p: string) => {
    if (!fileCache.has(p)) fileCache.set(p, (await view.read(p, 256 * 1024).catch(() => undefined))?.split('\n'));
    return fileCache.get(p);
  };
  for (const f of files) {
    if (f.binary || f.status === 'deleted') continue;
    const { needles, paths } = extractIdentifiers(f);
    const snippets: RelatedSnippet[] = [];

    // Folders and files the change names: what's in them, and the README that explains them.
    let named = 0;
    for (const p of paths) {
      if (named >= 4) break;
      if (changed.has(p)) continue;
      const listing = await view.list?.(p, 2000).catch(() => undefined);
      if (listing?.length) {
        const shown = listing.slice(0, 8).map((x) => `  ${x}`);
        const more = listing.length > 8 ? `  … ${listing.length >= 2000 ? '2000+' : listing.length} files in total` : '';
        const last = await view.lastChange?.(p).catch(() => undefined);
        if (last) shown.unshift(`  (last changed by commit ${last})`);
        named++;
        snippets.push({ path: p + '/', reason: `folder named in ${f.path}; it is in the repository at this commit`, text: [...shown, more].filter(Boolean).join('\n'), rank: 1 });
        const readme = await nearestReadme(view, p);
        if (readme && !changed.has(readme.path)) {
          snippets.push({ path: readme.path, reason: `README for ${p}`, text: readme.text.slice(0, 3000), rank: 1.5 });
        }
      } else {
        const t = await linesOf(p);
        if (t) {
          named++;
          snippets.push({ path: p, reason: `file named in ${f.path}`, text: snippetAround(t, 1, 0, 25), rank: 3 });
        }
      }
    }

    if (view.grep && needles.length) {
      const hits = (await view.grep(needles, 200).catch(() => [] as GrepHit[])).filter((h) => !opts.exclude(h.path));
      // Group hits by file; skip the changed file's own hunks (they're already shown).
      const byFile = new Map<string, { hits: GrepHit[]; needles: Set<string> }>();
      for (const h of hits) {
        const ns = needles.filter((n) => h.text.includes(n));
        if (!ns.length) continue;
        if (h.path === f.path && f.hunks.some((hk) => h.line >= hk.newStart - 3 && h.line < hk.newStart + hk.newLines + 3)) continue;
        if (!byFile.has(h.path)) byFile.set(h.path, { hits: [], needles: new Set() });
        const e = byFile.get(h.path)!;
        e.hits.push(h);
        ns.forEach((n) => e.needles.add(n));
      }
      for (const [p, e] of byFile) {
        const lines = await linesOf(p);
        if (!lines) continue;
        // Rank: other files before the same file, docs and tests next, more distinct identifiers first.
        let rank = p === f.path ? 4 : changed.has(p) ? 5 : 2;
        if (DOC_RE.test(p)) rank -= 0.5;
        if (TEST_RE.test(p)) rank -= 0.3;
        rank -= Math.min(e.needles.size, 3) * 0.2;
        const shown: string[] = [];
        let lastEnd = 0;
        for (const h of e.hits.slice(0, 3)) {
          if (h.line - 2 <= lastEnd) continue;
          shown.push(snippetAround(lines, h.line, 2, DOC_RE.test(p) ? 6 : 4));
          lastEnd = h.line + 4;
        }
        snippets.push({ path: p, reason: `uses ${[...e.needles].slice(0, 3).join(', ')}`, text: shown.join('\n   …\n'), rank });
      }
    }
    snippets.sort((a, b) => a.rank - b.rank);
    const kept = snippets.slice(0, opts.maxPerFile ?? 8);
    if (kept.length) {
      result.set(f.path, kept);
      opts.log.info(`context: related to ${f.path}: ${kept.map((s) => `${s.path} (${s.reason})`).join('; ')}`);
    }
  }
  return result;
}

/** Render the related-code section for one request, most relevant first, within maxChars. */
export function renderRelated(snippets: RelatedSnippet[], maxChars: number): string {
  if (maxChars < 200 || !snippets.length) return '';
  const seen = new Set<string>();
  const parts: string[] = [];
  let size = 0;
  for (const s of [...snippets].sort((a, b) => a.rank - b.rank)) {
    const key = `${s.path}\n${s.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let block = `--- ${s.path} (${s.reason}) ---\n${s.text}`;
    if (size + block.length > maxChars) {
      const room = maxChars - size - 40;
      if (room < 300) continue;
      block = block.slice(0, room) + '\n…[cut]';
    }
    parts.push(block);
    size += block.length + 1;
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Project guidelines
// ---------------------------------------------------------------------------

/** Conventional guides an agent or contributor reads first; used when no instructions file is found. */
export const DEFAULT_INSTRUCTIONS_FALLBACK = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', 'CONTRIBUTING.md'];

const KEY_SECTION = /review|test|deploy|release|data|convention|rule|never|don'?t|do not|must|security|gotcha|caveat|important|warning|production|migrat|generated|mirror|sync|import|state/i;

/**
 * Trim a guide to maxChars, keeping its structure: every heading, then the sections most likely to matter
 * to a reviewer (deploys, data, tests, rules) in full, then as much of the rest as fits, in document order.
 */
export function trimGuidelines(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  const sections: { head: string; body: string[]; key: boolean; idx: number }[] = [];
  let cur = { head: '', body: [] as string[], key: false, idx: 0 };
  for (const l of lines) {
    if (/^#{1,6}\s/.test(l)) {
      sections.push(cur);
      cur = { head: l, body: [], key: KEY_SECTION.test(l), idx: sections.length };
    } else cur.body.push(l);
  }
  sections.push(cur);
  // Intro (before the first heading) counts as key: it usually says what the project is.
  sections[0].key = true;
  const chosen = new Map<number, string>();
  let size = sections.reduce((n, s) => n + s.head.length + 1, 0);
  const take = (s: (typeof sections)[number]) => {
    const body = s.body.join('\n').trim();
    if (!body || chosen.has(s.idx)) return;
    const room = maxChars - size - 30;
    if (room < 120) return;
    const b = body.length <= room ? body : body.slice(0, room) + ' …';
    chosen.set(s.idx, b);
    size += b.length + 2;
  };
  sections.filter((s) => s.key).forEach(take);
  sections.filter((s) => !s.key).forEach(take);
  const out = sections
    .map((s) => [s.head, chosen.get(s.idx)].filter((x) => x !== undefined && x !== '').join('\n'))
    .filter(Boolean)
    .join('\n\n');
  return out.length > maxChars ? out.slice(0, maxChars) + '\n…[truncated]' : out + '\n…[trimmed to fit]';
}

/**
 * Review guidelines: the configured instructions file if it exists, else the first conventional guide
 * (AGENTS.md, CLAUDE.md, …) found. Read from `view`, so for a PR it's the base branch's copy.
 */
export async function loadGuidelines(
  view: RepoView,
  instructionsFile: string,
  fallback: string[],
  maxChars: number,
  log: Logger,
): Promise<{ text: string; source: string } | undefined> {
  if (maxChars <= 0) return undefined;
  const candidates = [instructionsFile, ...fallback].map((x) => x.trim()).filter(Boolean);
  for (const c of candidates) {
    const t = await view.read(c, 256 * 1024).catch(() => undefined);
    if (t === undefined || !t.trim()) continue;
    const text = trimGuidelines(t, maxChars);
    log.info(`Using review guidelines from ${c} (${view.describe})${text.length < t.length ? `, trimmed from ${t.length} to ${text.length} chars` : ''}`);
    return { text, source: c };
  }
  return undefined;
}
