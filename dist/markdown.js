"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fence = fence;
exports.countBySeverity = countBySeverity;
exports.countLine = countLine;
exports.sanitizeText = sanitizeText;
const types_1 = require("./types");
/** Wrap code in a backtick fence longer than any backtick run inside it. */
function fence(code, lang = '') {
    const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((s) => s.length));
    const f = '`'.repeat(longest + 1);
    return `${f}${lang}\n${code.replace(/\n$/, '')}\n${f}`;
}
/** Non-zero severity counts, most severe first. */
function countBySeverity(findings) {
    return types_1.SEVERITIES.map((severity) => ({ severity, count: findings.filter((f) => f.severity === severity).length })).filter((c) => c.count > 0);
}
/** "2 critical · 1 minor" (or `none` when empty). */
function countLine(findings, sep = ' · ', none = 'no issues found') {
    const c = countBySeverity(findings);
    return c.length ? c.map(({ severity, count }) => `${count} ${severity}`).join(sep) : none;
}
/**
 * Strip control characters (except tab and newline) from model-controlled text, so a prompt-injected
 * reply can't smuggle terminal escape sequences (OSC 52 clipboard writes, fake hyperlinks, …) into output.
 */
function sanitizeText(s) {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
