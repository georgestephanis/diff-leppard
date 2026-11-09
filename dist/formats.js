"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toSarif = toSarif;
exports.toRdjson = toRdjson;
/**
 * Machine-readable output formats for other tools:
 * - SARIF 2.1.0: GitHub code scanning (upload-sarif), many IDEs and dashboards.
 * - rdjson (reviewdog Diagnostic Format): reviewdog can post it to GitHub, GitLab, Bitbucket, Gitea, Gerrit.
 */
const crypto_1 = require("crypto");
const github_1 = require("./github");
const SARIF_LEVEL = { critical: 'error', major: 'error', minor: 'warning', nit: 'note' };
/** GitHub code scanning's security-severity scale (0–10), for security findings. */
const SECURITY_SEVERITY = { critical: '9.0', major: '7.0', minor: '4.0', nit: '1.0' };
const RDJSON_SEVERITY = { critical: 'ERROR', major: 'ERROR', minor: 'WARNING', nit: 'INFO' };
const ruleId = (f) => (f.category || 'general').replace(/[^\w-]/g, '-');
function message(f) {
    return f.body && f.body !== f.title ? `${f.title}\n\n${f.body}` : f.title;
}
/** Whether the suggestion can safely be offered as an exact replacement of [line, endLine]. */
function exactSuggestion(f) {
    return !!f.suggestion && f.inline && !f.lineAdjusted && f.line !== undefined;
}
function toSarif(result, version) {
    const located = result.findings.filter((f) => !f.file.startsWith('('));
    const rules = [...new Set(located.map(ruleId))].sort().map((id) => ({
        id,
        name: id,
        shortDescription: { text: id === 'general' ? 'General code review finding' : `Code review: ${id}` },
        properties: { tags: ['code-review', 'ai', ...(id === 'security' ? ['security'] : [])] },
    }));
    const results = located.map((f) => {
        const region = { startLine: f.line ?? 1 };
        if (f.endLine && f.line && f.endLine > f.line)
            region.endLine = f.endLine;
        const r = {
            ruleId: ruleId(f),
            level: SARIF_LEVEL[f.severity],
            message: { text: message(f) },
            locations: [{ physicalLocation: { artifactLocation: { uri: f.file, uriBaseId: '%SRCROOT%' }, region } }],
            partialFingerprints: {
                // Stable across line shifts, so code scanning tracks one alert per issue.
                'diffLeppard/v1': (0, crypto_1.createHash)('sha256').update(`${f.file}\0${ruleId(f)}\0${f.title.toLowerCase()}`).digest('hex').slice(0, 32),
            },
            properties: {
                severity: f.severity,
                ...(f.category === 'security' ? { 'security-severity': SECURITY_SEVERITY[f.severity] } : {}),
                ...(f.lineAdjusted ? { approximateLocation: true } : {}),
            },
        };
        if (exactSuggestion(f)) {
            r.fixes = [
                {
                    description: { text: 'Suggested change' },
                    artifactChanges: [
                        {
                            artifactLocation: { uri: f.file, uriBaseId: '%SRCROOT%' },
                            replacements: [
                                {
                                    deletedRegion: { startLine: f.line, endLine: f.endLine ?? f.line },
                                    insertedContent: { text: f.suggestion.replace(/\n?$/, '\n') },
                                },
                            ],
                        },
                    ],
                },
            ];
        }
        return r;
    });
    return {
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        version: '2.1.0',
        runs: [
            {
                tool: { driver: { name: 'Diff Leppard', informationUri: github_1.PROJECT_URL, version, rules } },
                results,
                properties: { model: result.model, summary: result.summary },
                ...(result.errors.length
                    ? {
                        invocations: [
                            {
                                executionSuccessful: false,
                                toolExecutionNotifications: result.errors.map((e) => ({ level: 'error', message: { text: e } })),
                            },
                        ],
                    }
                    : {}),
            },
        ],
    };
}
function toRdjson(result) {
    return {
        source: { name: 'diff-leppard', url: github_1.PROJECT_URL },
        diagnostics: result.findings
            .filter((f) => !f.file.startsWith('('))
            .map((f) => {
            const start = f.line ?? 1;
            const end = f.endLine && f.endLine > start ? f.endLine : start;
            const d = {
                message: message(f),
                location: { path: f.file, range: { start: { line: start }, end: { line: end } } },
                severity: RDJSON_SEVERITY[f.severity],
                code: { value: ruleId(f), url: github_1.PROJECT_URL },
            };
            if (exactSuggestion(f)) {
                // Whole-line replacement: from column 1 of the first line to column 1 of the line after the last.
                d.suggestions = [{ range: { start: { line: start, column: 1 }, end: { line: end + 1, column: 1 } }, text: f.suggestion.replace(/\n?$/, '\n') }];
            }
            return d;
        }),
    };
}
