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
exports.git = git;
exports.getRepoRoot = getRepoRoot;
exports.getHeadSha = getHeadSha;
exports.getRemotes = getRemotes;
exports.isNullSha = isNullSha;
exports.resolveRef = resolveRef;
exports.getLocalDiff = getLocalDiff;
exports.readRepoFile = readRepoFile;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const path = __importStar(require("path"));
const diff_1 = require("./diff");
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
function git(cwd, args, allowFail = false) {
    return new Promise((resolve, reject) => {
        (0, child_process_1.execFile)('git', ['-c', 'core.quotePath=false', ...args], { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }, (err, stdout, stderr) => {
            if (err && !allowFail)
                reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim() || err.message}`));
            else
                resolve(err ? '' : stdout);
        });
    });
}
async function getRepoRoot(dir) {
    const out = await git(dir, ['rev-parse', '--show-toplevel'], true);
    return out.trim() || undefined;
}
async function getHeadSha(root) {
    const out = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], true);
    return out.trim() || undefined;
}
async function getRemotes(root) {
    const out = await git(root, ['remote', '-v'], true);
    const seen = new Set();
    const remotes = [];
    for (const line of out.split('\n')) {
        const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
        if (m && !seen.has(m[1])) {
            seen.add(m[1]);
            remotes.push({ name: m[1], url: m[2] });
        }
    }
    return remotes;
}
/** True for git's all-zeros "no commit" object id (e.g. pre-push of a new branch). */
function isNullSha(ref) {
    return !!ref && /^0+$/.test(ref);
}
/** Resolve a ref to a commit SHA. Refs come from users and agents (MCP), so nothing that git could read as an option. */
async function resolveRef(root, ref) {
    if (!ref || ref.startsWith('-'))
        throw new Error(`Invalid git ref: ${ref}`);
    const sha = (await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true)).trim();
    if (!sha)
        throw new Error(`Unknown git ref: ${ref}`);
    return sha;
}
async function getLocalDiff(root, opts) {
    let base = (await getHeadSha(root)) ?? EMPTY_TREE;
    if (opts.base) {
        const mb = (await git(root, ['merge-base', await resolveRef(root, opts.base), 'HEAD'], true)).trim();
        if (!mb)
            throw new Error(`No common ancestor between ${opts.base} and HEAD`);
        base = mb;
    }
    // Pin the output format regardless of the user's git config (diff.noprefix, diff.mnemonicPrefix, diff.relative, …).
    const common = [
        '-c', 'diff.noprefix=false',
        '-c', 'diff.mnemonicPrefix=false',
        'diff', '--no-color', '--no-ext-diff', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/',
        '--find-renames', `-U${opts.contextLines}`,
    ];
    let args;
    if (opts.range) {
        const from = isNullSha(opts.range.from) ? EMPTY_TREE : await resolveRef(root, opts.range.from);
        args = [...common, from, await resolveRef(root, opts.range.to)];
    }
    else {
        args = opts.stagedOnly ? [...common, '--cached', base] : [...common, base];
    }
    const files = (0, diff_1.parseUnifiedDiff)(await git(root, args));
    const skipped = [];
    if (!opts.stagedOnly && !opts.range && opts.includeUntracked) {
        const out = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
        for (const rel of out.split('\0').filter(Boolean)) {
            if (opts.exclude(rel)) {
                skipped.push({ path: rel, reason: 'excluded by diffLeppard.excludeGlobs' });
                continue;
            }
            const abs = path.join(root, rel);
            try {
                // lstat: never follow an untracked symlink out of the repo (git itself only shows the link text).
                const st = await fs_1.promises.lstat(abs);
                if (st.isSymbolicLink()) {
                    skipped.push({ path: rel, reason: 'symlink' });
                    continue;
                }
                if (!st.isFile())
                    continue;
                if (st.size > opts.maxUntrackedBytes) {
                    skipped.push({ path: rel, reason: `untracked file larger than ${Math.round(opts.maxUntrackedBytes / 1024)} KB` });
                    continue;
                }
                const buf = await fs_1.promises.readFile(abs);
                if (buf.subarray(0, 8000).includes(0)) {
                    skipped.push({ path: rel, reason: 'binary' });
                    continue;
                }
                files.push((0, diff_1.fileDiffFromContent)(rel, buf.toString('utf8')));
            }
            catch (e) {
                skipped.push({ path: rel, reason: `unreadable: ${e.message}` });
            }
        }
    }
    return { files, skipped };
}
/**
 * Read a repo-relative file (e.g. review guidelines), truncated to maxChars. Refuses paths that resolve
 * outside the repo, including through symlinks, so config can't pull e.g. ~/.aws/credentials into a prompt.
 */
async function readRepoFile(root, rel, maxChars = 8000) {
    try {
        const realRoot = await fs_1.promises.realpath(root);
        const real = await fs_1.promises.realpath(path.resolve(root, rel));
        if (real !== realRoot && !real.startsWith(realRoot + path.sep))
            return undefined;
        const text = await fs_1.promises.readFile(real, 'utf8');
        return text.length > maxChars ? text.slice(0, maxChars) + '\n…[truncated]' : text;
    }
    catch {
        return undefined;
    }
}
