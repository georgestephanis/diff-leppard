import { GitHubClient, PullRequestInfo, RepoRef } from './github';
import { FileDiff } from './types';

export interface LoadedPullRequest {
  pr: PullRequestInfo;
  files: FileDiff[];
  skipped: { path: string; reason: string }[];
}

/** Fetch everything needed to review a PR. Shared by the VS Code extension and the CLI. */
export async function loadPullRequest(
  gh: GitHubClient,
  repo: RepoRef,
  number: number,
  /** Already-fetched PR metadata, to avoid fetching it twice. */
  prefetched?: PullRequestInfo,
): Promise<LoadedPullRequest> {
  const pr = prefetched ?? (await gh.getPull(repo, number));
  const { files, skipped } = await gh.getPullFiles(repo, number);
  return { pr, files, skipped };
}
