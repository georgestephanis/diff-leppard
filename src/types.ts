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
  /** True when the model's line number was not in the diff and was snapped to a nearby diff line. */
  lineAdjusted?: boolean;
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
