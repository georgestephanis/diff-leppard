import { Chunk } from './diff';
import { ChatMessage } from './llm';

export const REVIEW_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          endLine: { type: 'integer' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
          category: {
            type: 'string',
            enum: ['bug', 'security', 'performance', 'error-handling', 'concurrency', 'api', 'maintainability', 'testing', 'docs', 'style'],
          },
          title: { type: 'string' },
          body: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['file', 'line', 'severity', 'title', 'body'],
      },
    },
  },
  required: ['summary', 'findings'],
};

export const SYSTEM_PROMPT = `You are a meticulous senior software engineer doing a code review of a diff.

Look for real problems introduced or touched by the change:
- bugs and logic errors, wrong conditions, off-by-one, null/undefined handling
- security issues (injection, XSS, missing auth/permission checks, secrets, unsafe deserialization, path traversal)
- data loss, race conditions, resource leaks, missing error handling
- performance problems (N+1 queries, needless work in loops, unbounded memory)
- API misuse and broken contracts with surrounding code
- clearly confusing or unmaintainable code, missing tests for risky logic

Rules:
- Only comment on lines that exist in the diff, preferably added lines (marked "+").
- Be specific and actionable. Explain WHY it is a problem and how to fix it.
- Every finding must describe a problem. Never add a finding just to describe or praise a change, and do not nitpick formatting a linter or formatter would handle.
- Do not invent problems. If you are unsure, either skip it or say so explicitly in the body. An empty findings list is a perfectly good answer.
- Think before you write, but put only your conclusion in the JSON: no step-by-step tracing, "wait", or self-corrections in a body.
- If, on reflection, something turns out to be correct, intentional, or "probably fine", leave it out entirely. Never report a finding whose conclusion is that no change is needed.
- Respect deliberate design decisions that the code or comments explain; only flag them if they are actually wrong.
- The summary must agree with your findings: don't describe a problem in the summary that you didn't report as a finding, and don't claim something is broken without a finding that shows where.
- You only see part of the code base. Do not report "X is not defined" when X could plausibly be defined elsewhere.

Diff format: each file starts with "=== File: <path> (<status>) ===", followed by hunks.
Every line is: <new-file line number> <marker> <code>, where the marker is "+" for added lines, "-" for removed lines (these have no line number), and a space for unchanged context lines.

Severity:
- critical: will break production, lose data, or is a security vulnerability
- major: a real bug or significant problem that should be fixed before merging
- minor: a small bug risk, edge case, or maintainability issue worth fixing
- nit: optional polish

Respond with ONLY a JSON object, no markdown fences and no other text:
{
  "summary": "1-3 sentence overall assessment of this change",
  "findings": [
    {
      "file": "exact path from the === File: line",
      "line": <line number from the left column of the line the comment is about>,
      "endLine": <optional last line number if the issue spans several lines>,
      "severity": "critical" | "major" | "minor" | "nit",
      "category": "bug" | "security" | "performance" | "error-handling" | "concurrency" | "api" | "maintainability" | "testing" | "docs" | "style",
      "title": "short one-line description",
      "body": "explanation and how to fix it (markdown allowed)",
      "suggestion": "optional: ONLY literal replacement code for exactly lines line..endLine, no prose; omit if unsure"
    }
  ]
}`;

export interface PromptContext {
  title?: string;
  description?: string;
  extraInstructions?: string;
  repoInstructions?: string;
  chunkIndex: number;
  chunkCount: number;
}

const MAX_DESCRIPTION = 4000;

export function buildReviewMessages(chunk: Chunk, ctx: PromptContext): ChatMessage[] {
  let system = SYSTEM_PROMPT;
  const guidelines = [ctx.repoInstructions?.trim(), ctx.extraInstructions?.trim()].filter(Boolean);
  if (guidelines.length) {
    system += `\n\nProject-specific review guidelines (follow these):\n${guidelines.join('\n\n')}`;
  }

  const parts: string[] = [];
  if (ctx.title) parts.push(`Change title: ${ctx.title}`);
  if (ctx.description?.trim()) {
    let d = ctx.description.trim();
    if (d.length > MAX_DESCRIPTION) d = d.slice(0, MAX_DESCRIPTION) + '\n…[truncated]';
    parts.push(`Change description:\n${d}`);
  }
  if (ctx.chunkCount > 1) {
    parts.push(
      `This change is large and has been split into ${ctx.chunkCount} parts. This is part ${ctx.chunkIndex + 1} of ${ctx.chunkCount}; review only what is shown here.`,
    );
  }
  parts.push(`Diff to review:\n\n${chunk.text}`);
  parts.push('Respond with the JSON object only.');
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

export function buildSynthesisMessages(
  title: string | undefined,
  partSummaries: string[],
  findingTitles: string[],
): ChatMessage[] {
  const user = [
    title ? `Change title: ${title}` : '',
    `A large change was reviewed in ${partSummaries.length} parts. Summaries of each part:`,
    partSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    findingTitles.length ? `Findings:\n${findingTitles.map((t) => `- ${t}`).join('\n')}` : 'No findings were reported.',
    'Write a single overall review summary of 2-4 sentences: what the change does and the most important concerns, if any. Respond with ONLY a JSON object: {"summary": "..."}',
  ]
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: 'You are a senior software engineer summarizing a code review.' },
    { role: 'user', content: user },
  ];
}
