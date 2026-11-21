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
exports.DEFAULT_INSTRUCTIONS_FALLBACK = void 0;
exports.safeRepoPath = safeRepoPath;
exports.gitRepoView = gitRepoView;
exports.githubRepoView = githubRepoView;
exports.localViewAt = localViewAt;
exports.planBudget = planBudget;
exports.attachFileContents = attachFileContents;
exports.extractIdentifiers = extractIdentifiers;
exports.extractPaths = extractPaths;
exports.findRelatedCode = findRelatedCode;
exports.renderRelated = renderRelated;
exports.trimGuidelines = trimGuidelines;
exports.loadGuidelines = loadGuidelines;
/**
 * Extra context for a review, beyond the diff hunks: the changed files' surrounding code (up to the whole
 * file), related code elsewhere in the repo, and the project's agent/contributor guide. Everything here is
 * sized from one budget, the characters the model's context window leaves for the prompt, so a bigger
 * context window buys more context and a small one degrades gracefully to plain hunks.
 *
 * No `vscode` imports.
 */
const diff_1 = require("./diff");
const git_1 = require("./git");
const DEFAULT_MAX_READ = 512 * 1024;
/** No path from the model or a diff may climb out of the repo or name git internals. */
function safeRepoPath(p) {
    const clean = p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!clean || clean.startsWith('/') || clean.startsWith('-') || /^[A-Za-z]:/.test(clean))
        return undefined;
    const parts = clean.split('/');
    if (parts.some((x) => x === '..' || x === '.git' || x === ''))
        return undefined;
    return clean;
}
/**
 * A view of a local git repository: at `rev` (a commit) or, with no rev, the working tree.
 * Reads go through git (`git show rev:path`, or the index/working tree via `git ls-files`), so nothing
 * outside the repository's tracked or untracked-but-not-ignored files is ever read.
 */
function gitRepoView(root, rev) {
    const tracked = async (p) => (await (0, git_1.git)(root, ['ls-files', '--cached', '--others', '--exclude-standard', '--', p], true)).split('\n').filter(Boolean);
    return {
        describe: rev ? `git ${rev.slice(0, 12)}` : 'working tree',
        async read(p, maxBytes = DEFAULT_MAX_READ) {
            const safe = safeRepoPath(p);
            if (!safe)
                return undefined;
            let text;
            if (rev) {
                const size = parseInt((await (0, git_1.git)(root, ['cat-file', '-s', `${rev}:${safe}`], true)).trim(), 10);
                if (!(size >= 0) || size > maxBytes)
                    return undefined;
                const type = (await (0, git_1.git)(root, ['cat-file', '-t', `${rev}:${safe}`], true)).trim();
                if (type !== 'blob')
                    return undefined;
                text = await (0, git_1.git)(root, ['cat-file', 'blob', `${rev}:${safe}`], true);
            }
            else {
                // Only files git would show (tracked, or untracked and not ignored): never a symlink out of the repo.
                if (!(await tracked(safe)).includes(safe))
                    return undefined;
                const { promises: fs } = await Promise.resolve().then(() => __importStar(require('fs')));
                const path = await Promise.resolve().then(() => __importStar(require('path')));
                try {
                    const abs = path.join(root, safe);
                    const st = await fs.lstat(abs);
                    if (!st.isFile() || st.size > maxBytes)
                        return undefined;
                    text = await fs.readFile(abs, 'utf8');
                }
                catch {
                    return undefined;
                }
            }
            if (text.slice(0, 8000).includes('\0'))
                return undefined;
            return text;
        },
        async grep(needles, maxHits) {
            const uniq = [...new Set(needles.filter((n) => n && !n.startsWith('-') && !n.includes('\n')))];
            if (!uniq.length)
                return [];
            const args = ['grep', '-n', '-I', '-F', '-z', '--full-name', '--no-color', '-m', '5'];
            for (const n of uniq)
                args.push('-e', n);
            if (rev)
                args.push(rev);
            else
                args.push('--untracked');
            args.push('--');
            const out = await (0, git_1.git)(root, args, true);
            const hits = [];
            const prefix = rev ? `${rev}:` : '';
            for (const row of out.split('\n')) {
                if (!row)
                    continue;
                const [p, ln, ...rest] = row.split('\0');
                const line = parseInt(ln, 10);
                if (!p || !(line > 0))
                    continue;
                hits.push({ path: p.startsWith(prefix) ? p.slice(prefix.length) : p, line, text: rest.join('\0') });
                if (hits.length >= maxHits)
                    break;
            }
            return hits;
        },
        async lastChange(p) {
            const safe = safeRepoPath(p);
            if (!safe)
                return undefined;
            const out = await (0, git_1.git)(root, ['log', '-1', '--format=%h %ad %s', '--date=short', ...(rev ? [rev] : []), '--', safe], true);
            return out.trim() || undefined;
        },
        async list(dir, max) {
            const safe = safeRepoPath(dir);
            if (!safe)
                return undefined;
            const out = rev
                ? await (0, git_1.git)(root, ['ls-tree', '-r', '--name-only', rev, '--', `${safe}/`], true)
                : (await tracked(`${safe}/`)).join('\n');
            const files = out.split('\n').filter(Boolean);
            return files.length ? files.slice(0, max) : undefined;
        },
    };
}
/** A view through the GitHub contents API (reads only; no search). Used for PRs without a local checkout. */
function githubRepoView(client, repo, sha) {
    return {
        describe: `GitHub ${repo.owner}/${repo.repo}@${sha.slice(0, 12)}`,
        async read(p, maxBytes = DEFAULT_MAX_READ) {
            const safe = safeRepoPath(p);
            if (!safe)
                return undefined;
            const text = await client.getFileContent(repo, safe, sha).catch(() => undefined);
            if (text === undefined || text.length > maxBytes || text.slice(0, 8000).includes('\0'))
                return undefined;
            return text;
        },
    };
}
/** A local checkout that has `sha`, as a view at that commit; undefined if there's no such checkout. */
async function localViewAt(root, sha) {
    if (!root || !sha || !/^[0-9a-f]{7,64}$/i.test(sha))
        return undefined;
    const ok = (await (0, git_1.git)(root, ['cat-file', '-e', `${sha}^{commit}`], true)) !== undefined;
    const exists = ok && (await (0, git_1.git)(root, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], true)).trim();
    return exists ? gitRepoView(root, sha) : undefined;
}
/**
 * Split one request's character budget (from the model's context window, see resolveChunkChars) between
 * guidelines, related code and the diff itself. Caps from settings are upper bounds; with a small
 * context window everything shrinks so the diff always keeps most of the room.
 */
function planBudget(total, s) {
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
async function attachFileContents(files, view, maxChars, log) {
    if (maxChars <= 0)
        return;
    let n = 0;
    await Promise.all(files.map(async (f) => {
        if (f.binary || f.status === 'deleted' || f.status === 'added')
            return; // an added file's hunk is already the whole file
        // Read a little more than the budget: widened context still helps when the whole file doesn't fit.
        const text = await view.read(f.path, maxChars * 8).catch(() => undefined);
        if (text === undefined)
            return;
        if (!(0, diff_1.contentMatchesDiff)(f, text)) {
            log.debug(`context: ${f.path} at ${view.describe} doesn't match the diff; using hunks only`);
            return;
        }
        f.content = text;
        n++;
    }));
    if (n)
        log.info(`context: loaded ${n} changed file(s) from ${view.describe} for surrounding code`);
}
const STOP = new Set('this that with from return function class const let var true false null none self else elif then while for each into when what where which there their have will would should could import export default async await static public private protected string number boolean object array value values items item data type types name names index length error errors result results options config props state value test tests main http https width height color display block inline none auto flex grid content'.split(' '));
/** Identifiers from the changed lines worth searching for elsewhere. Most specific first. */
function extractIdentifiers(f) {
    const changed = f.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== 'ctx').map((l) => l.text));
    const text = changed.join('\n');
    const out = new Map();
    const add = (s, weight) => {
        if (s.length < 4 || STOP.has(s.toLowerCase()))
            return;
        out.set(s, Math.max(out.get(s) ?? 0, weight + Math.min(s.length, 30) / 10));
    };
    const isStyle = /\.(css|scss|sass|less|html?|vue|svelte|jsx|tsx|hbs|njk|liquid|twig|php|erb)$/i.test(f.path);
    let m;
    // Definitions: function/class/def names.
    const defRe = /\b(?:function|def|class|interface|type|enum|func|fn|sub|macro)\s+([A-Za-z_$][\w$]{3,})/g;
    while ((m = defRe.exec(text)))
        add(m[1], 5);
    const assignRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]{4,})\s*=\s*(?:async\s*)?(?:function|\(|[A-Za-z_$][\w$]*\s*=>)/g;
    while ((m = assignRe.exec(text)))
        add(m[1], 4);
    // CLI flags and environment variables / constants.
    const flagRe = /(?<![\w-])(--[a-z][\w-]{2,})/g;
    while ((m = flagRe.exec(text)))
        add(m[1], 4);
    const envRe = /\b([A-Z][A-Z0-9]*_[A-Z0-9_]{2,})\b/g;
    while ((m = envRe.exec(text)))
        add(m[1], 3);
    if (isStyle) {
        // CSS classes from selectors and class attributes (only multi-part names: "btn" is everywhere).
        const clsRe = /(?:^|[\s,>+~(])\.([a-zA-Z][\w-]*-[\w-]+)/gm;
        while ((m = clsRe.exec(text)))
            add('.' + m[1], 3);
        const attrRe = /class(?:Name)?=["'{]([^"'}]+)/g;
        while ((m = attrRe.exec(text)))
            for (const c of m[1].split(/\s+/))
                if (/^[a-zA-Z][\w]*-[\w-]+$/.test(c))
                    add(c, 2);
    }
    // Paths: from the changed lines first, then from the rest of the file (a default directory is often set
    // once at the top). Callers check that they exist.
    const isDoc = /\.(md|mdx|rst|txt|adoc)$/i.test(f.path);
    const paths = [...new Set([...extractPaths(text), ...(f.content && !isDoc ? extractPaths(f.content) : [])])];
    const needles = [...out.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    return { needles: needles.slice(0, 12), paths: paths.slice(0, 12) };
}
/** Repo-relative path candidates in text: quoted paths, joined segments ("a" / "b", join('a', 'b')) and bare a/b/c. */
function extractPaths(text) {
    const found = [];
    const push = (raw) => {
        if (/^[a-z][\w+.-]*:\/\//i.test(raw) || raw.startsWith('//'))
            return;
        // Drop globs and trailing file patterns: data/x/*.json -> data/x
        const cut = raw.replace(/\/?[^/]*[*?{[][^/]*$/, '').replace(/^\.\//, '');
        const p = safeRepoPath(cut);
        if (p && p.includes('/') && !found.includes(p))
            found.push(p);
    };
    let m;
    const quoted = /["'`]((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.*-]+)+\/?)["'`]/g;
    while ((m = quoted.exec(text)))
        push(m[1]);
    // "data" / "x" / "y"   or   join("data", "x", "y")
    const seg = `["']([\\w@.-]+)["']`;
    const joined = new RegExp(`${seg}(?:\\s*(?:/|,)\\s*${seg})+`, 'g');
    while ((m = joined.exec(text))) {
        const parts = m[0].match(/["']([\w@.-]+)["']/g).map((x) => x.slice(1, -1));
        if (parts.length >= 2 && parts.every((x) => !/^\.+$/.test(x)))
            push(parts.join('/'));
    }
    const bare = /(?<![\w@:/.-])((?:[\w@-][\w@.-]*\/){1,}[\w@.*-]+)\/?(?![\w(])/g;
    while ((m = bare.exec(text)))
        if (/[a-z]/i.test(m[1]) && !/^\d/.test(m[1]))
            push(m[1]);
    return found;
}
const DOC_RE = /(^|\/)(README|CONTRIBUTING|ARCHITECTURE|AGENTS|CLAUDE)[^/]*$|\.(md|mdx|rst|txt|adoc)$/i;
const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+$/i;
function snippetAround(lines, hit, before, after) {
    const a = Math.max(1, hit - before);
    const b = Math.min(lines.length, hit + after);
    const width = Math.max(4, String(b).length);
    const out = [];
    for (let i = a; i <= b; i++)
        out.push(`${String(i).padStart(width)}   ${lines[i - 1]}`);
    return out.join('\n');
}
/** The nearest README at or above `dir` (not the repo root's: that one is usually generic). */
async function nearestReadme(view, dir) {
    const parts = dir.split('/');
    for (let i = parts.length; i >= 1; i--) {
        const d = parts.slice(0, i).join('/');
        for (const name of ['README.md', 'README', 'readme.md', 'README.txt']) {
            const t = await view.read(`${d}/${name}`, 64 * 1024).catch(() => undefined);
            if (t !== undefined)
                return { path: `${d}/${name}`, text: t };
        }
    }
    return undefined;
}
/**
 * Cheap retrieval, no model calls: search the repo for identifiers the change touches, and look at
 * folders the change names. Returns snippets ranked most relevant first, keyed by changed file.
 */
async function findRelatedCode(files, view, opts) {
    const result = new Map();
    const changed = new Set(files.map((f) => f.path));
    const fileCache = new Map();
    const linesOf = async (p) => {
        if (!fileCache.has(p))
            fileCache.set(p, (await view.read(p, 256 * 1024).catch(() => undefined))?.split('\n'));
        return fileCache.get(p);
    };
    for (const f of files) {
        if (f.binary || f.status === 'deleted')
            continue;
        const { needles, paths } = extractIdentifiers(f);
        const snippets = [];
        // Folders and files the change names: what's in them, and the README that explains them.
        let named = 0;
        for (const p of paths) {
            if (named >= 4)
                break;
            if (changed.has(p))
                continue;
            const listing = await view.list?.(p, 2000).catch(() => undefined);
            if (listing?.length) {
                const shown = listing.slice(0, 8).map((x) => `  ${x}`);
                const more = listing.length > 8 ? `  … ${listing.length >= 2000 ? '2000+' : listing.length} files in total` : '';
                const last = await view.lastChange?.(p).catch(() => undefined);
                if (last)
                    shown.unshift(`  (last changed by commit ${last})`);
                named++;
                snippets.push({ path: p + '/', reason: `folder named in ${f.path}; it is in the repository at this commit`, text: [...shown, more].filter(Boolean).join('\n'), rank: 1 });
                const readme = await nearestReadme(view, p);
                if (readme && !changed.has(readme.path)) {
                    snippets.push({ path: readme.path, reason: `README for ${p}`, text: readme.text.slice(0, 3000), rank: 1.5 });
                }
            }
            else {
                const t = await linesOf(p);
                if (t) {
                    named++;
                    snippets.push({ path: p, reason: `file named in ${f.path}`, text: snippetAround(t, 1, 0, 25), rank: 3 });
                }
            }
        }
        if (view.grep && needles.length) {
            const hits = (await view.grep(needles, 200).catch(() => [])).filter((h) => !opts.exclude(h.path));
            // Group hits by file; skip the changed file's own hunks (they're already shown).
            const byFile = new Map();
            for (const h of hits) {
                const ns = needles.filter((n) => h.text.includes(n));
                if (!ns.length)
                    continue;
                if (h.path === f.path && f.hunks.some((hk) => h.line >= hk.newStart - 3 && h.line < hk.newStart + hk.newLines + 3))
                    continue;
                if (!byFile.has(h.path))
                    byFile.set(h.path, { hits: [], needles: new Set() });
                const e = byFile.get(h.path);
                e.hits.push(h);
                ns.forEach((n) => e.needles.add(n));
            }
            for (const [p, e] of byFile) {
                const lines = await linesOf(p);
                if (!lines)
                    continue;
                // Rank: other files before the same file, docs and tests next, more distinct identifiers first.
                let rank = p === f.path ? 4 : changed.has(p) ? 5 : 2;
                if (DOC_RE.test(p))
                    rank -= 0.5;
                if (TEST_RE.test(p))
                    rank -= 0.3;
                rank -= Math.min(e.needles.size, 3) * 0.2;
                const shown = [];
                let lastEnd = 0;
                for (const h of e.hits.slice(0, 3)) {
                    if (h.line - 2 <= lastEnd)
                        continue;
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
function renderRelated(snippets, maxChars) {
    if (maxChars < 200 || !snippets.length)
        return '';
    const seen = new Set();
    const parts = [];
    let size = 0;
    for (const s of [...snippets].sort((a, b) => a.rank - b.rank)) {
        const key = `${s.path}\n${s.text}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        let block = `--- ${s.path} (${s.reason}) ---\n${s.text}`;
        if (size + block.length > maxChars) {
            const room = maxChars - size - 40;
            if (room < 300)
                continue;
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
exports.DEFAULT_INSTRUCTIONS_FALLBACK = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', 'CONTRIBUTING.md'];
const KEY_SECTION = /review|test|deploy|release|data|convention|rule|never|don'?t|do not|must|security|gotcha|caveat|important|warning|production|migrat|generated|mirror|sync|import|state/i;
/**
 * Trim a guide to maxChars, keeping its structure: every heading, then the sections most likely to matter
 * to a reviewer (deploys, data, tests, rules) in full, then as much of the rest as fits, in document order.
 */
function trimGuidelines(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    const lines = text.split('\n');
    const sections = [];
    let cur = { head: '', body: [], key: false, idx: 0 };
    for (const l of lines) {
        if (/^#{1,6}\s/.test(l)) {
            sections.push(cur);
            cur = { head: l, body: [], key: KEY_SECTION.test(l), idx: sections.length };
        }
        else
            cur.body.push(l);
    }
    sections.push(cur);
    // Intro (before the first heading) counts as key: it usually says what the project is.
    sections[0].key = true;
    const chosen = new Map();
    let size = sections.reduce((n, s) => n + s.head.length + 1, 0);
    const take = (s) => {
        const body = s.body.join('\n').trim();
        if (!body || chosen.has(s.idx))
            return;
        const room = maxChars - size - 30;
        if (room < 120)
            return;
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
async function loadGuidelines(view, instructionsFile, fallback, maxChars, log) {
    if (maxChars <= 0)
        return undefined;
    const candidates = [instructionsFile, ...fallback].map((x) => x.trim()).filter(Boolean);
    for (const c of candidates) {
        const t = await view.read(c, 256 * 1024).catch(() => undefined);
        if (t === undefined || !t.trim())
            continue;
        const text = trimGuidelines(t, maxChars);
        log.info(`Using review guidelines from ${c} (${view.describe})${text.length < t.length ? `, trimmed from ${t.length} to ${text.length} chars` : ''}`);
        return { text, source: c };
    }
    return undefined;
}
