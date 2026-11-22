export type Severity = 'critical' | 'major' | 'minor' | 'nit';

/** Ordered most to least severe. */
export const SEVERITIES: Severity[] = ['critical', 'major', 'minor', 'nit'];

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface FileDiff {
  /** Path in the new version (or the old path for deleted files), repo-relative, forward slashes. */
  path: string;
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
  /** The new version's full text, when loaded for context (whole-file or widened rendering). Never sent as-is. */
  content?: string;
}

export interface Finding {
  file: string;
  /** 1-based line in the new version of the file. */
  line?: number;
  endLine?: number;
  severity: Severity;
  category?: string;
  title: string;
  body: string;
  suggestion?: string;
  /** True when (file, line[, endLine]) maps onto lines that are part of the diff, i.e. can be an inline PR comment. */
  inline: boolean;
  /** True when the location is approximate: the line was snapped to a nearby diff line, or a multi-line range was dropped. */
  lineAdjusted?: boolean;
  /** Set by the verification pass: true = confirmed, false = rejected (only in `rejectedFindings`), undefined = not checked or unsure. */
  verified?: boolean;
  /** Lines the reviewer quoted as evidence (verification pass or agentic mode). */
  evidence?: string;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  model: string;
  reviewedFiles: string[];
  skippedFiles: { path: string; reason: string }[];
  chunkCount: number;
  errors: string[];
  durationMs: number;
  /** Findings the verification pass rejected (not in `findings`), kept for auditing. */
  rejectedFindings?: Finding[];
  /** What extra context went into the review, for logs and evaluation. */
  contextNotes?: string[];
  /** PR reviews: the head commit reviewed, so a client can tell whether its checkout matches the line numbers. */
  headSha?: string;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export const nullLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};
