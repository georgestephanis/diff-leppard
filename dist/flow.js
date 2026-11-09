"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.llmBase = llmBase;
exports.makeLlm = makeLlm;
exports.reviewPullRequest = reviewPullRequest;
/** End-to-end review flows shared by the CLI's `pr` and `watch` commands (no `vscode` imports). */
const config_1 = require("./config");
const diff_1 = require("./diff");
const llm_1 = require("./llm");
const pr_1 = require("./pr");
const report_1 = require("./report");
const review_1 = require("./review");
function llmBase(s) {
    return {
        provider: s.provider,
        baseUrl: s.baseUrl,
        apiKey: s.apiKey || undefined,
        temperature: s.temperature,
        maxOutputTokens: s.maxOutputTokens,
        jsonMode: s.jsonMode,
        stream: s.stream,
        timeoutMs: s.requestTimeoutSeconds * 1000,
        ollamaNumCtx: s.ollamaNumCtx,
        extraHeaders: s.extraHeaders,
        extraBody: s.extraBody,
    };
}
/** A client for the configured model; with no model set, uses the server's only model. */
async function makeLlm(s, log) {
    const cfg = { ...llmBase(s), model: s.model };
    if (!cfg.model) {
        const models = await new llm_1.LlmClient(cfg, log).listModels();
        if (models.length !== 1) {
            throw new Error(models.length
                ? `No model configured and the server has ${models.length}: ${models.join(', ')}. Pass --model or set "model" in ${(0, config_1.userConfigPath)()}.`
                : `The server at ${cfg.baseUrl} reported no models.`);
        }
        cfg.model = models[0];
        log.info(`Using the server's only model: ${cfg.model}`);
    }
    return new llm_1.LlmClient(cfg, log);
}
/**
 * Review one pull request: apply the repo config from the PR's *base* branch (a PR can't change how it is
 * itself reviewed), load the diff and guidelines, size chunks to the model, and run the review.
 */
async function reviewPullRequest(p) {
    const label = `${p.repo.owner}/${p.repo.repo}#${p.number}`;
    let s = p.settings;
    const pr0 = p.prefetched ?? (await p.client.getPull(p.repo, p.number));
    const repoCfgText = await p.client.getFileContent(p.repo, config_1.REPO_CONFIG_FILE, pr0.baseSha).catch(() => undefined);
    if (repoCfgText !== undefined) {
        let json;
        try {
            json = (0, config_1.parseJsonc)(repoCfgText);
        }
        catch (e) {
            throw new Error(`Could not parse ${config_1.REPO_CONFIG_FILE} on ${pr0.baseRef} of ${label}: ${e.message}`);
        }
        if (json && typeof json === 'object' && !Array.isArray(json)) {
            const source = `${p.repo.owner}/${p.repo.repo}@${pr0.baseRef}:${config_1.REPO_CONFIG_FILE}`;
            const loaded = await p.configure({ json: json, source });
            s = loaded.settings;
            p.log.info(`config: ${source}`);
            for (const w of loaded.warnings)
                p.log.warn(w);
        }
    }
    const loaded = await (0, pr_1.loadPullRequest)(p.client, p.repo, p.number, s.instructionsFile, p.log, pr0);
    const llm = await makeLlm(s, p.log);
    const result = await (0, review_1.runReview)(loaded.files, {
        llm,
        maxChunkChars: await (0, llm_1.resolveChunkChars)(llm, s.maxChunkChars, s.maxOutputTokens, p.log, p.signal),
        concurrency: s.concurrency,
        minimumSeverity: s.minimumSeverity,
        exclude: (0, diff_1.makeExcluder)(s.excludeGlobs),
        context: { title: loaded.pr.title, description: loaded.pr.body, extraInstructions: s.extraInstructions, repoInstructions: loaded.repoInstructions },
        log: p.log,
        signal: p.signal,
        onProgress: p.onProgress,
        preSkipped: loaded.skipped,
    });
    const pr = loaded.pr;
    const title = `Review of ${label}: ${pr.title}`;
    const markdown = () => (0, report_1.renderMarkdownReport)(result, {
        title,
        source: `[${label}](${pr.htmlUrl}) by @${pr.author} (${pr.headRef} → ${pr.baseRef})`,
        blobBaseUrl: `https://${p.host}/${p.repo.owner}/${p.repo.repo}/blob/${pr.headSha}`,
    });
    return { pr, result, settings: s, title, markdown };
}
