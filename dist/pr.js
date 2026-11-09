"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadPullRequest = loadPullRequest;
const types_1 = require("./types");
const MAX_INSTRUCTIONS = 8000;
/** Fetch everything needed to review a PR. Shared by the VS Code extension and the CLI. */
async function loadPullRequest(gh, repo, number, instructionsFile, log = types_1.nullLogger, 
/** Already-fetched PR metadata, to avoid fetching it twice. */
prefetched) {
    const pr = prefetched ?? (await gh.getPull(repo, number));
    const { files, skipped } = await gh.getPullFiles(repo, number);
    let repoInstructions;
    if (instructionsFile) {
        repoInstructions = await gh.getFileContent(repo, instructionsFile, pr.baseSha).catch(() => undefined);
        if (repoInstructions) {
            log.info(`Using review guidelines from ${instructionsFile}@${pr.baseRef}`);
            if (repoInstructions.length > MAX_INSTRUCTIONS)
                repoInstructions = repoInstructions.slice(0, MAX_INSTRUCTIONS) + '\n…[truncated]';
        }
    }
    return { pr, files, skipped, repoInstructions };
}
