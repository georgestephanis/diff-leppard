import { GitHubClient, PullRequestInfo, RepoRef } from './github';
import { FileDiff, Logger, nullLogger } from './types';

export interface LoadedPullRequest {
  pr: PullRequestInfo;
  files: FileDiff[];
  skipped: { path: string; reason: string }[];
  /** Contents of the repo's review-guidelines file on the PR's base branch, if present. */
  repoInstructions?: string;
}

const MAX_INSTRUCTIONS = 8000;

/** Fetch everything needed to review a PR. Shared by the VS Code extension and the CLI. */
export async function loadPullRequest(
  gh: GitHubClient,
  repo: RepoRef,
  number: number,
  instructionsFile: string | undefined,
  log: Logger = nullLogger,
): Promise<LoadedPullRequest> {
  const pr = await gh.getPull(repo, number);
  const { files, skipped } = await gh.getPullFiles(repo, number);
  let repoInstructions: string | undefined;
  if (instructionsFile) {
    repoInstructions = await gh.getFileContent(repo, instructionsFile, pr.baseSha).catch(() => undefined);
    if (repoInstructions) {
      log.info(`Using review guidelines from ${instructionsFile}@${pr.baseRef}`);
      if (repoInstructions.length > MAX_INSTRUCTIONS) repoInstructions = repoInstructions.slice(0, MAX_INSTRUCTIONS) + '\n…[truncated]';
    }
  }
  return { pr, files, skipped, repoInstructions };
}
