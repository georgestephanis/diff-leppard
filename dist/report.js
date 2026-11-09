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
exports.renderMarkdownReport = renderMarkdownReport;
const path = __importStar(require("path"));
const markdown_1 = require("./markdown");
const ICON = { critical: '🔴', major: '🟠', minor: '🟡', nit: '⚪' };
function link(file, line, meta) {
    const label = line ? `${file}:${line}` : file;
    if (meta.repoRoot && meta.reportDir) {
        const rel = path.relative(meta.reportDir, path.join(meta.repoRoot, file));
        const url = rel.split(path.sep).map(encodeURIComponent).join('/') + (line ? `#L${line}` : '');
        return `[\`${label}\`](${url})`;
    }
    if (meta.blobBaseUrl) {
        return `[\`${label}\`](${meta.blobBaseUrl}/${file.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''})`;
    }
    return `\`${label}\``;
}
function renderMarkdownReport(result, meta) {
    const out = [];
    out.push(`# ${meta.title}`, '');
    out.push(`*${meta.source} · model \`${result.model}\` · ${(result.durationMs / 1000).toFixed(1)}s · ${result.reviewedFiles.length} file(s) in ${result.chunkCount} request(s)*`, '');
    if (meta.postedUrl)
        out.push(`**Posted to GitHub:** ${meta.postedUrl}`, '');
    if (result.summary)
        out.push('## Summary', '', result.summary, '');
    if (result.errors.length) {
        out.push('## ⚠️ Errors', '');
        for (const e of result.errors)
            out.push(`- ${e}`);
        out.push('');
    }
    out.push(`## Findings (${result.findings.length})`, '');
    if (!result.findings.length)
        out.push('No issues found at or above the configured severity.', '');
    const byFile = new Map();
    for (const f of result.findings) {
        if (!byFile.has(f.file))
            byFile.set(f.file, []);
        byFile.get(f.file).push(f);
    }
    for (const [file, list] of byFile) {
        out.push(`### ${file}`, '');
        for (const f of list) {
            const range = f.endLine && f.line && f.endLine > f.line ? `-${f.endLine}` : '';
            out.push(`#### ${ICON[f.severity]} ${f.severity}${f.category ? ` · ${f.category}` : ''} — ${f.title}`, '', `${link(file, f.line, meta)}${range}${f.inline ? '' : ' *(not on a changed line)*'}${f.lineAdjusted ? ' *(line approximated)*' : ''}`, '');
            if (f.body)
                out.push(f.body, '');
            if (f.suggestion)
                out.push('Suggested change:', '', (0, markdown_1.fence)(f.suggestion), '');
        }
    }
    if (result.skippedFiles.length) {
        out.push('## Not reviewed', '');
        for (const s of result.skippedFiles)
            out.push(`- \`${s.path}\` — ${s.reason}`);
        out.push('');
    }
    out.push('---', '*AI-generated review — verify findings before acting on them.*', '');
    return out.join('\n');
}
