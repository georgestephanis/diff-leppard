"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderTerminal = renderTerminal;
const markdown_1 = require("./markdown");
const SGR = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m', gray: '\x1b[90m', magenta: '\x1b[35m', cyan: '\x1b[36m' };
const SEV_COLOR = { critical: 'red', major: 'magenta', minor: 'yellow', nit: 'gray' };
/** Human-friendly terminal output. `file:line` locations are clickable in most terminals and editors. */
function renderTerminal(result, opts) {
    const c = (style, s) => (opts.color ? style.split(' ').map((k) => SGR[k]).join('') + s + SGR.reset : s);
    const out = [];
    if (opts.title)
        out.push(c('bold', opts.title), '');
    if (result.summary)
        out.push(result.summary, '');
    if (!result.findings.length)
        out.push(c('bold', '✓ No issues found at or above the configured severity.'));
    for (const f of result.findings) {
        const loc = f.line ? `${f.file}:${f.line}${f.endLine && f.endLine > f.line ? `-${f.endLine}` : ''}` : f.file;
        const sev = c(`bold ${SEV_COLOR[f.severity]}`, f.severity.toUpperCase().padEnd(8));
        out.push(`${sev} ${c('cyan', loc)}${f.category ? c('gray', ` [${f.category}]`) : ''}`);
        out.push(`         ${c('bold', f.title)}`);
        if (f.body && f.body !== f.title)
            out.push(...f.body.split('\n').map((l) => `         ${l}`));
        if (f.suggestion) {
            out.push(`         ${c('dim', 'Suggested change:')}`);
            out.push(...f.suggestion.replace(/\n$/, '').split('\n').map((l) => `         ${c('blue', '│ ')}${l}`));
        }
        out.push('');
    }
    if (result.skippedFiles.length) {
        out.push(c('gray', `Not reviewed: ${result.skippedFiles.map((s) => `${s.path} (${s.reason})`).join(', ')}`));
    }
    for (const e of result.errors)
        out.push(c('red', `Error: ${e}`));
    const counts = (0, markdown_1.countLine)(result.findings, ', ', '');
    out.push(c('gray', `${result.findings.length} finding(s)${counts ? ` (${counts})` : ''} · ${result.model} · ${(result.durationMs / 1000).toFixed(1)}s · ${result.reviewedFiles.length} file(s) in ${result.chunkCount} request(s)`));
    return out.join('\n') + '\n';
}
