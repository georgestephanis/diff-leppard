/**
 * Machine-readable output formats for other tools:
 * - SARIF 2.1.0: GitHub code scanning (upload-sarif), many IDEs and dashboards.
 * - rdjson (reviewdog Diagnostic Format): reviewdog can post it to GitHub, GitLab, Bitbucket, Gitea, Gerrit.
 */
import { createHash } from 'crypto';
import { PROJECT_URL } from './github';
import { Finding, ReviewResult, Severity } from './types';

const SARIF_LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = { critical: 'error', major: 'error', minor: 'warning', nit: 'note' };
/** GitHub code scanning's security-severity scale (0–10), for security findings. */
const SECURITY_SEVERITY: Record<Severity, string> = { critical: '9.0', major: '7.0', minor: '4.0', nit: '1.0' };
const RDJSON_SEVERITY: Record<Severity, 'ERROR' | 'WARNING' | 'INFO'> = { critical: 'ERROR', major: 'ERROR', minor: 'WARNING', nit: 'INFO' };

const ruleId = (f: Finding) => (f.category || 'general').replace(/[^\w-]/g, '-');

function message(f: Finding): string {
  return f.body && f.body !== f.title ? `${f.title}\n\n${f.body}` : f.title;
}

/** Whether the suggestion can safely be offered as an exact replacement of [line, endLine]. */
function exactSuggestion(f: Finding): boolean {
  return !!f.suggestion && f.inline && !f.lineAdjusted && f.line !== undefined;
}

export function toSarif(result: ReviewResult, version: string): object {
  const located = result.findings.filter((f) => !f.file.startsWith('('));
  const rules = [...new Set(located.map(ruleId))].sort().map((id) => ({
    id,
    name: id,
    shortDescription: { text: id === 'general' ? 'General code review finding' : `Code review: ${id}` },
    properties: { tags: ['code-review', 'ai', ...(id === 'security' ? ['security'] : [])] },
  }));
  const results = located.map((f) => {
    const region: Record<string, number> = { startLine: f.line ?? 1 };
    if (f.endLine && f.line && f.endLine > f.line) region.endLine = f.endLine;
    const r: Record<string, unknown> = {
      ruleId: ruleId(f),
      level: SARIF_LEVEL[f.severity],
      message: { text: message(f) },
      locations: [{ physicalLocation: { artifactLocation: { uri: f.file, uriBaseId: '%SRCROOT%' }, region } }],
      partialFingerprints: {
        // Stable across line shifts, so code scanning tracks one alert per issue.
        'diffLeppard/v1': createHash('sha256').update(`${f.file}\0${ruleId(f)}\0${f.title.toLowerCase()}`).digest('hex').slice(0, 32),
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
                  insertedContent: { text: f.suggestion!.replace(/\n?$/, '\n') },
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
        tool: { driver: { name: 'Diff Leppard', informationUri: PROJECT_URL, version, rules } },
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

export function toRdjson(result: ReviewResult): object {
  return {
    source: { name: 'diff-leppard', url: PROJECT_URL },
    diagnostics: result.findings
      .filter((f) => !f.file.startsWith('('))
      .map((f) => {
        const start = f.line ?? 1;
        const end = f.endLine && f.endLine > start ? f.endLine : start;
        const d: Record<string, unknown> = {
          message: message(f),
          location: { path: f.file, range: { start: { line: start }, end: { line: end } } },
          severity: RDJSON_SEVERITY[f.severity],
          code: { value: ruleId(f), url: PROJECT_URL },
        };
        if (exactSuggestion(f)) {
          // Whole-line replacement: from column 1 of the first line to column 1 of the line after the last.
          d.suggestions = [{ range: { start: { line: start, column: 1 }, end: { line: end + 1, column: 1 } }, text: f.suggestion!.replace(/\n?$/, '\n') }];
        }
        return d;
      }),
  };
}
