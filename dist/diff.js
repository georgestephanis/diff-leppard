"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseUnifiedDiff = parseUnifiedDiff;
exports.parsePatchHunks = parsePatchHunks;
exports.fileDiffFromContent = fileDiffFromContent;
exports.commentableLines = commentableLines;
exports.addedLines = addedLines;
exports.annotateFile = annotateFile;
exports.chunkDiff = chunkDiff;
exports.globToRegExp = globToRegExp;
exports.makeExcluder = makeExcluder;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
/** Incrementally reads hunk bodies, tracking old/new line numbers. */
class HunkReader {
    hunk;
    oldNo = 0;
    newNo = 0;
    remOld = 0;
    remNew = 0;
    /** Returns a new Hunk if `line` is a hunk header. */
    start(line) {
        const m = HUNK_RE.exec(line);
        if (!m)
            return undefined;
        const oldStart = parseInt(m[1], 10);
        const oldLines = m[2] === undefined ? 1 : parseInt(m[2], 10);
        const newStart = parseInt(m[3], 10);
        const newLines = m[4] === undefined ? 1 : parseInt(m[4], 10);
        this.hunk = { header: line, oldStart, oldLines, newStart, newLines, lines: [] };
        this.oldNo = oldStart;
        this.newNo = newStart;
        this.remOld = oldLines;
        this.remNew = newLines;
        return this.hunk;
    }
    /** True while the current hunk still expects body lines. */
    inBody() {
        return !!this.hunk && (this.remOld > 0 || this.remNew > 0);
    }
    feed(line) {
        const h = this.hunk;
        const c = line.charAt(0);
        let dl;
        if (c === '+') {
            dl = { kind: 'add', text: line.slice(1), newLine: this.newNo++ };
            this.remNew--;
        }
        else if (c === '-') {
            dl = { kind: 'del', text: line.slice(1), oldLine: this.oldNo++ };
            this.remOld--;
        }
        else {
            // ' ' context, or an empty line from tools that strip trailing whitespace.
            dl = { kind: 'ctx', text: line.slice(1), oldLine: this.oldNo++, newLine: this.newNo++ };
            this.remOld--;
            this.remNew--;
        }
        h.lines.push(dl);
    }
}
function unquote(p) {
    p = p.trim();
    if (p.startsWith('"') && p.endsWith('"')) {
        // git C-style quoting; handle the common escapes.
        p = p
            .slice(1, -1)
            .replace(/\\([\\"tn])/g, (_m, ch) => ({ t: '\t', n: '\n' }[ch] ?? ch));
    }
    return p;
}
function stripPrefix(p) {
    p = unquote(p.split('\t')[0]);
    return p.replace(/^[ab]\//, '');
}
/** Parse the output of `git diff` (one or more files) into structured file diffs. */
function parseUnifiedDiff(text) {
    const files = [];
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let cur;
    const reader = new HunkReader();
    const newFile = () => {
        const f = { path: '', status: 'modified', binary: false, hunks: [] };
        files.push(f);
        reader.hunk = undefined;
        return f;
    };
    for (const line of lines) {
        if (reader.inBody() && !line.startsWith('\\')) {
            reader.feed(line);
            continue;
        }
        if (line.startsWith('\\'))
            continue; // "\ No newline at end of file"
        if (line.startsWith('diff --git ')) {
            cur = newFile();
            const m = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
            if (m) {
                cur.oldPath = m[1];
                cur.path = m[2];
            }
            continue;
        }
        if (line.startsWith('--- ') && (!cur || reader.hunk)) {
            // A plain unified diff without "diff --git" headers, or the next file.
            cur = newFile();
        }
        if (!cur)
            continue;
        if (line.startsWith('@@')) {
            const h = reader.start(line);
            if (h)
                cur.hunks.push(h);
            continue;
        }
        if (line.startsWith('new file mode'))
            cur.status = 'added';
        else if (line.startsWith('deleted file mode'))
            cur.status = 'deleted';
        else if (line.startsWith('rename from ')) {
            cur.oldPath = unquote(line.slice('rename from '.length));
            cur.status = 'renamed';
        }
        else if (line.startsWith('rename to ')) {
            cur.path = unquote(line.slice('rename to '.length));
            cur.status = 'renamed';
        }
        else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
            cur.binary = true;
        }
        else if (line.startsWith('--- ')) {
            const p = line.slice(4);
            if (p.trim() === '/dev/null')
                cur.status = 'added';
            else
                cur.oldPath = stripPrefix(p);
        }
        else if (line.startsWith('+++ ')) {
            const p = line.slice(4);
            if (p.trim() === '/dev/null') {
                cur.status = 'deleted';
                cur.path = cur.oldPath ?? cur.path;
            }
            else
                cur.path = stripPrefix(p);
        }
    }
    for (const f of files) {
        if (!f.path && f.oldPath)
            f.path = f.oldPath;
        if (f.status === 'modified' && f.oldPath && f.oldPath !== f.path)
            f.status = 'renamed';
        if (f.status !== 'renamed' && f.oldPath === f.path)
            delete f.oldPath;
    }
    return files.filter((f) => f.path);
}
/** Parse just the hunks of a patch (as returned by GitHub's pull request files API). */
function parsePatchHunks(patch) {
    const reader = new HunkReader();
    const hunks = [];
    for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
        if (reader.inBody() && !line.startsWith('\\')) {
            reader.feed(line);
        }
        else if (line.startsWith('@@')) {
            const h = reader.start(line);
            if (h)
                hunks.push(h);
        }
    }
    return hunks;
}
/** Build a FileDiff for a brand new file from its full contents. */
function fileDiffFromContent(path, content) {
    const text = content.replace(/\r\n/g, '\n');
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    const hunk = {
        header: `@@ -0,0 +1,${lines.length} @@`,
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines: lines.map((t, i) => ({ kind: 'add', text: t, newLine: i + 1 })),
    };
    return { path, status: 'added', binary: false, hunks: text.length ? [hunk] : [] };
}
/** For each commentable new-side line (added or context lines inside a hunk), the index of its hunk. */
function commentableLines(file) {
    const m = new Map();
    file.hunks.forEach((h, idx) => {
        for (const l of h.lines)
            if (l.newLine !== undefined)
                m.set(l.newLine, idx);
    });
    return m;
}
/** Set of new-side line numbers that were added. */
function addedLines(file) {
    const s = new Set();
    for (const h of file.hunks)
        for (const l of h.lines)
            if (l.kind === 'add' && l.newLine !== undefined)
                s.add(l.newLine);
    return s;
}
// ---------------------------------------------------------------------------
// Annotation & chunking for the model
// ---------------------------------------------------------------------------
function fileHeader(f, continued = false) {
    let desc = f.status;
    if (f.status === 'renamed' && f.oldPath)
        desc = `renamed from ${f.oldPath}`;
    return `=== File: ${f.path} (${desc}${continued ? ', continued' : ''}) ===`;
}
function annotateLine(l, width) {
    const num = l.newLine !== undefined ? String(l.newLine).padStart(width) : ' '.repeat(width);
    const marker = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
    return `${num} ${marker} ${l.text}`;
}
/** Render a hunk with explicit new-file line numbers so the model can cite them. */
function annotateHunkLines(h, lines, continued) {
    const maxLine = h.newStart + h.newLines;
    const width = Math.max(4, String(maxLine).length);
    const header = continued ? `@@ (hunk continued) @@` : h.header;
    return [header, ...lines.map((l) => annotateLine(l, width))].join('\n');
}
function annotateFile(f) {
    return [fileHeader(f), ...f.hunks.map((h) => annotateHunkLines(h, h.lines, false))].join('\n');
}
/** Split one file into annotated segments, each at most maxChars (except pathological single lines). */
function fileSegments(f, maxChars) {
    const segs = [];
    for (const h of f.hunks) {
        const full = annotateHunkLines(h, h.lines, false);
        if (full.length <= maxChars) {
            segs.push({ file: f, text: full });
            continue;
        }
        // Split an oversized hunk by lines; line numbers are explicit so pieces stay meaningful.
        const maxLine = h.newStart + h.newLines;
        const width = Math.max(4, String(maxLine).length);
        let buf = [];
        let size = 0;
        let first = true;
        const flush = () => {
            if (!buf.length)
                return;
            segs.push({ file: f, text: [first ? h.header : '@@ (hunk continued) @@', ...buf].join('\n') });
            first = false;
            buf = [];
            size = 0;
        };
        for (const l of h.lines) {
            const s = annotateLine(l, width);
            if (size + s.length + 1 > maxChars - 40 && buf.length)
                flush();
            buf.push(s.length > maxChars ? s.slice(0, maxChars - 60) + ' …[line truncated]' : s);
            size += s.length + 1;
        }
        flush();
    }
    return segs;
}
/**
 * Pack files into chunks of at most `maxChars` characters of annotated diff.
 * Small files are grouped together; big files are split at hunk (or line) boundaries.
 */
function chunkDiff(files, maxChars) {
    const chunks = [];
    let parts = [];
    let chunkFiles = [];
    let size = 0;
    let lastFile;
    const flush = () => {
        if (!parts.length)
            return;
        chunks.push({ files: chunkFiles, text: parts.join('\n') });
        parts = [];
        chunkFiles = [];
        size = 0;
        lastFile = undefined;
    };
    for (const f of files) {
        if (!f.hunks.length)
            continue;
        const header = fileHeader(f);
        const segs = fileSegments(f, maxChars - header.length - 40);
        let firstSeg = true;
        for (const seg of segs) {
            const needHeader = lastFile !== f;
            const h = needHeader ? (firstSeg ? header : fileHeader(f, true)) : '';
            const add = (h ? h.length + 1 : 0) + seg.text.length + 1;
            if (size + add > maxChars && parts.length) {
                flush();
                const h2 = firstSeg ? header : fileHeader(f, true);
                parts.push(h2);
                size += h2.length + 1;
            }
            else if (h) {
                if (parts.length) {
                    parts.push('');
                    size += 1;
                }
                parts.push(h);
                size += h.length + 1;
            }
            if (!chunkFiles.includes(f))
                chunkFiles.push(f);
            parts.push(seg.text);
            size += seg.text.length + 1;
            lastFile = f;
            firstSeg = false;
        }
    }
    flush();
    return chunks;
}
// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------
function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 2;
                }
                else {
                    re += '.*';
                    i += 1;
                }
            }
            else
                re += '[^/]*';
        }
        else if (c === '?')
            re += '[^/]';
        else if (c === '{') {
            const end = glob.indexOf('}', i);
            if (end > i) {
                const alts = glob.slice(i + 1, end).split(',').map((a) => a.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'));
                re += `(?:${alts.join('|')})`;
                i = end;
            }
            else
                re += '\\{';
        }
        else
            re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
    }
    return new RegExp(`^${re}$`);
}
function makeExcluder(globs) {
    const matchers = globs
        .filter((g) => g.trim())
        .map((g) => {
        const re = globToRegExp(g.trim());
        const basenameOnly = !g.includes('/');
        return (p) => re.test(basenameOnly ? p.split('/').pop() ?? p : p);
    });
    return (p) => matchers.some((m) => m(p));
}
