import * as path from 'path';
import { ReviewResult, Severity } from './types';

const ICON: Record<Severity, string> = { critical: '🔴', major: '🟠', minor: '🟡', nit: '⚪' };

export interface ReportMeta {
  title: string;
  source: string;
  /** When set, file references link to local files. */
  repoRoot?: string;
  /** Directory the report is written to. Local links are relative to it (the markdown preview blocks file: URLs). */
  reportDir?: string;
  /** When set (PR reviews), file references link to the PR's files on GitHub. */
  blobBaseUrl?: string;
  postedUrl?: string;
}

function fence(code: string): string {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((s) => s.length));
  const f = '`'.repeat(longest + 1);
  return `${f}\n${code.replace(/\n$/, '')}\n${f}`;
}

function link(file: string, line: number | undefined, meta: ReportMeta): string {
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

export function renderMarkdownReport(result: ReviewResult, meta: ReportMeta): string {
  const out: string[] = [];
  out.push(`# ${meta.title}`, '');
  out.push(`*${meta.source} · model \`${result.model}\` · ${(result.durationMs / 1000).toFixed(1)}s · ${result.reviewedFiles.length} file(s) in ${result.chunkCount} request(s)*`, '');
  if (meta.postedUrl) out.push(`**Posted to GitHub:** ${meta.postedUrl}`, '');
  if (result.summary) out.push('## Summary', '', result.summary, '');

  if (result.errors.length) {
    out.push('## ⚠️ Errors', '');
    for (const e of result.errors) out.push(`- ${e}`);
    out.push('');
  }

  out.push(`## Findings (${result.findings.length})`, '');
  if (!result.findings.length) out.push('No issues found at or above the configured severity.', '');

  const byFile = new Map<string, typeof result.findings>();
  for (const f of result.findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file)!.push(f);
  }
  for (const [file, list] of byFile) {
    out.push(`### ${file}`, '');
    for (const f of list) {
      const range = f.endLine && f.line && f.endLine > f.line ? `-${f.endLine}` : '';
      out.push(
        `#### ${ICON[f.severity]} ${f.severity}${f.category ? ` · ${f.category}` : ''} — ${f.title}`,
        '',
        `${link(file, f.line, meta)}${range}${f.inline ? '' : ' *(not on a changed line)*'}${f.lineAdjusted ? ' *(line approximated)*' : ''}`,
        '',
      );
      if (f.body) out.push(f.body, '');
      if (f.suggestion) out.push('Suggested change:', '', fence(f.suggestion), '');
    }
  }

  if (result.skippedFiles.length) {
    out.push('## Not reviewed', '');
    for (const s of result.skippedFiles) out.push(`- \`${s.path}\` — ${s.reason}`);
    out.push('');
  }
  out.push('---', '*AI-generated review — verify findings before acting on them.*', '');
  return out.join('\n');
}
