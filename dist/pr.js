"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadPullRequest = loadPullRequest;
/** Fetch everything needed to review a PR. Shared by the VS Code extension and the CLI. */
async function loadPullRequest(gh, repo, number, 
/** Already-fetched PR metadata, to avoid fetching it twice. */
prefetched) {
    const pr = prefetched ?? (await gh.getPull(repo, number));
    const { files, skipped } = await gh.getPullFiles(repo, number);
    return { pr, files, skipped };
}
