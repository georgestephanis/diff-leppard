"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewInputError = void 0;
exports.llmBase = llmBase;
exports.makeLlm = makeLlm;
exports.reviewPullRequest = reviewPullRequest;
exports.defaultRepo = defaultRepo;
exports.reviewLocalChanges = reviewLocalChanges;
/** End-to-end review flows shared by the CLI's `pr` and `watch` commands (no `vscode` imports). */
const config_1 = require("./config");
const path = __importStar(require("path"));
const diff_1 = require("./diff");
const gh_1 = require("./gh");
const git_1 = require("./git");
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
/** A problem with what was asked for (bad ref, not a repo, …), as opposed to a failure while reviewing. */
class ReviewInputError extends Error {
}
exports.ReviewInputError = ReviewInputError;
/** The GitHub repo for a checkout: what `gh` thinks, else the first GitHub remote (upstream, then origin). */
async function defaultRepo(cwd, root, host) {
    try {
        const nwo = await (0, gh_1.ghExec)(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd);
        const m = /^([^/]+)\/([^/]+)$/.exec(nwo);
        if (m)
            return { owner: m[1], repo: m[2] };
    }
    catch {
        /* no gh, or not a GitHub repo for gh */
    }
    return (await (0, gh_1.githubRemotes)(root, host))[0]?.repo;
}
/** Review local changes in a repo (shared by `diff-leppard local` and the MCP server). */
async function reviewLocalChanges(p) {
    const s = p.settings;
    if ([p.staged, p.base, p.range].filter(Boolean).length > 1)
        throw new ReviewInputError('Use only one of staged, base and range');
    let range;
    if (p.range) {
        const m = /^(.+?)(\.{2,3})(.+)$/.exec(p.range);
        if (!m)
            throw new ReviewInputError('range must look like <from>..<to> (or <from>...<to> for "since the merge-base")');
        range = { from: m[1], to: m[3] };
        if (m[2] === '...') {
            let mb = '';
            try {
                mb = (await (0, git_1.git)(p.root, ['merge-base', await (0, git_1.resolveRef)(p.root, m[1]), await (0, git_1.resolveRef)(p.root, m[3])])).trim();
            }
            catch (e) {
                throw new ReviewInputError(e.message);
            }
            if (!mb)
                throw new ReviewInputError(`No common ancestor between ${m[1]} and ${m[3]}`);
            range.from = mb;
        }
    }
    const what = p.range ? `commits ${p.range}` : p.base ? `changes since ${p.base}` : p.staged ? 'staged changes' : 'uncommitted changes';
    const name = path.basename(p.root);
    const title = `Review of ${what} — ${name}`;
    p.onProgress?.('Collecting diff…');
    const exclude = (0, diff_1.makeExcluder)(s.excludeGlobs);
    let diff;
    try {
        diff = await (0, git_1.getLocalDiff)(p.root, {
            stagedOnly: !!p.staged,
            base: p.base,
            range,
            contextLines: s.contextLines,
            includeUntracked: s.includeUntracked,
            maxUntrackedBytes: 256 * 1024,
            exclude,
        });
    }
    catch (e) {
        throw new ReviewInputError(e.message);
    }
    if (!diff.files.length)
        return { what, title, markdown: () => `No ${what} in ${name}.\n` };
    const repoInstructions = s.instructionsFile ? await (0, git_1.readRepoFile)(p.root, s.instructionsFile) : undefined;
    if (repoInstructions)
        p.log.info(`Using review guidelines from ${s.instructionsFile}`);
    const llm = await makeLlm(s, p.log);
    const result = await (0, review_1.runReview)(diff.files, {
        llm,
        maxChunkChars: await (0, llm_1.resolveChunkChars)(llm, s.maxChunkChars, s.maxOutputTokens, p.log, p.signal),
        concurrency: s.concurrency,
        minimumSeverity: s.minimumSeverity,
        exclude,
        context: { extraInstructions: s.extraInstructions, repoInstructions },
        log: p.log,
        signal: p.signal,
        onProgress: p.onProgress,
        preSkipped: diff.skipped,
    });
    return {
        what,
        result,
        title,
        markdown: () => (0, report_1.renderMarkdownReport)(result, { title, source: `${what[0].toUpperCase()}${what.slice(1)} in **${name}**` }),
    };
}
