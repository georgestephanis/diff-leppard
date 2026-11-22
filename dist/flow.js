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
exports.prepareContext = prepareContext;
exports.commitMessages = commitMessages;
exports.defaultRepo = defaultRepo;
exports.reviewLocalChanges = reviewLocalChanges;
/** End-to-end review flows shared by the CLI's `pr` and `watch` commands (no `vscode` imports). */
const config_1 = require("./config");
const path = __importStar(require("path"));
const context_1 = require("./context");
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
    // Guidelines come from prepareContext (base branch, with the AGENTS.md fallback), not loadPullRequest.
    const loaded = await (0, pr_1.loadPullRequest)(p.client, p.repo, p.number, undefined, p.log, pr0);
    const llm = await makeLlm(s, p.log);
    // A local checkout that has the PR's head commit allows searching the repo; otherwise read through the API.
    const local = await (0, context_1.localViewAt)(p.localRoot, loaded.pr.headSha);
    const ctx = await prepareContext({
        files: loaded.files,
        settings: s,
        llm,
        view: local ?? (loaded.pr.headSha ? (0, context_1.githubRepoView)(p.client, p.repo, loaded.pr.headSha) : undefined),
        guideView: (await (0, context_1.localViewAt)(p.localRoot, loaded.pr.baseSha)) ?? (loaded.pr.baseSha ? (0, context_1.githubRepoView)(p.client, p.repo, loaded.pr.baseSha) : undefined),
        log: p.log,
        signal: p.signal,
    });
    if (s.agentic && !local)
        p.log.warn('Agentic mode needs a local clone that has the PR head commit (run from a checkout and fetch it); reviewing without tools.');
    const result = await (0, review_1.runReview)(loaded.files, {
        llm,
        ...ctx,
        concurrency: s.concurrency,
        minimumSeverity: s.minimumSeverity,
        exclude: (0, diff_1.makeExcluder)(s.excludeGlobs),
        verify: s.verifyFindings,
        agent: s.agentic && local ? { view: local, before: await (0, context_1.localViewAt)(p.localRoot, loaded.pr.baseSha), maxToolCalls: s.maxToolCalls, exclude: (0, diff_1.makeExcluder)(s.excludeGlobs) } : undefined,
        context: {
            title: loaded.pr.title,
            description: loaded.pr.body,
            checkDescription: s.checkDescription,
            extraInstructions: s.extraInstructions,
            repoInstructions: ctx.repoInstructions,
        },
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
async function prepareContext(p) {
    const s = p.settings;
    const total = await (0, llm_1.resolveChunkChars)(p.llm, s.maxChunkChars, s.maxOutputTokens, p.log, p.signal);
    const plan = (0, context_1.planBudget)(total, s);
    const notes = [];
    let repoInstructions;
    if (p.guideView && plan.instructions > 0) {
        const g = await (0, context_1.loadGuidelines)(p.guideView, s.instructionsFile, s.instructionsFallback, plan.instructions, p.log);
        if (g) {
            repoInstructions = g.text;
            notes.push(`guidelines: ${g.source} (${g.text.length} chars)`);
        }
    }
    const used = (repoInstructions?.length ?? 0) + (s.relatedMaxChars > 0 && p.view?.grep ? plan.related : 0);
    const maxChunkChars = Math.max(Math.min(2000, total), total - used);
    const contextChars = Math.min(plan.fullFile, Math.floor(maxChunkChars * 0.8));
    if (p.view && contextChars > 0) {
        await (0, context_1.attachFileContents)(p.files, p.view, contextChars, p.log, (0, diff_1.makeExcluder)(s.excludeGlobs));
        const loaded = p.files.filter((f) => f.content).length;
        if (loaded)
            notes.push(`surrounding code: up to ${contextChars} chars per file, ${loaded} file(s) loaded`);
    }
    let related;
    if (p.view && s.relatedMaxChars > 0 && plan.related > 0) {
        if (!p.view.grep)
            p.log.info(`context: related-code search needs a local checkout of the reviewed commit; skipped (${p.view.describe})`);
        else {
            related = await (0, context_1.findRelatedCode)(p.files, p.view, { exclude: (0, diff_1.makeExcluder)(s.excludeGlobs), log: p.log });
            for (const [f, sn] of related)
                notes.push(`related to ${f}: ${sn.map((x) => `${x.path} (${x.reason})`).join('; ')}`);
        }
    }
    p.log.info(`Request budget ${total} chars: diff ${maxChunkChars}, guidelines ${repoInstructions?.length ?? 0}, related up to ${s.relatedMaxChars ? plan.related : 0}+`);
    return { maxChunkChars, contextChars, related, relatedChars: { reserve: plan.related, max: s.relatedMaxChars }, contextNotes: notes, repoInstructions, view: p.view };
}
/** Commit messages of a range as a change title + description (at most 20 commits / 4000 chars). */
async function commitMessages(root, range) {
    if (!range || range.startsWith('-'))
        return undefined;
    const out = await (0, git_1.git)(root, ['log', '--no-merges', '-n', '20', '--format=%s%x1f%b%x1e', range, '--'], true);
    const commits = out
        .split('\x1e')
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => {
        const [subject, body = ''] = c.split('\x1f');
        return { subject: subject.trim(), body: body.trim() };
    });
    if (!commits.length)
        return undefined;
    if (commits.length === 1)
        return { title: commits[0].subject, description: commits[0].body.slice(0, 4000) };
    return { description: commits.map((c) => `- ${c.subject}${c.body ? `\n  ${c.body.replace(/\n/g, '\n  ')}` : ''}`).join('\n').slice(0, 4000) };
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
    const llm = await makeLlm(s, p.log);
    // The reviewed revision: the range's end commit, else the working tree. Guidelines come from the range's
    // start (like a PR's base), else the working tree.
    const toSha = range ? await (0, git_1.resolveRef)(p.root, range.to) : undefined;
    const fromSha = range && !(0, git_1.isNullSha)(range.from) ? await (0, git_1.resolveRef)(p.root, range.from).catch(() => undefined) : undefined;
    // What the reviewed code is read from (staged reviews: the index, not the working tree), and what it changed from.
    const reviewed = (0, context_1.gitRepoView)(p.root, toSha ?? (p.staged ? context_1.INDEX : undefined));
    let beforeRev = fromSha;
    if (!range) {
        beforeRev = p.base
            ? (await (0, git_1.git)(p.root, ['merge-base', await (0, git_1.resolveRef)(p.root, p.base), 'HEAD'], true)).trim() || undefined
            : (await (0, git_1.git)(p.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], true)).trim() || undefined;
    }
    const before = beforeRev ? (0, context_1.gitRepoView)(p.root, beforeRev) : undefined;
    const ctx = await prepareContext({
        files: diff.files,
        settings: s,
        llm,
        view: reviewed,
        guideView: range ? (0, context_1.gitRepoView)(p.root, fromSha ?? toSha) : reviewed,
        log: p.log,
        signal: p.signal,
    });
    let changeTitle = p.title;
    let changeDescription = p.description;
    if (changeDescription === undefined && (range || p.base)) {
        const msgs = await commitMessages(p.root, range ? (fromSha ? `${fromSha}..${toSha}` : toSha) : `${p.base}..HEAD`);
        if (msgs) {
            changeTitle ??= msgs.title;
            changeDescription = msgs.description;
        }
    }
    const result = await (0, review_1.runReview)(diff.files, {
        llm,
        ...ctx,
        concurrency: s.concurrency,
        minimumSeverity: s.minimumSeverity,
        exclude,
        verify: s.verifyFindings,
        agent: s.agentic
            ? { view: reviewed, before, maxToolCalls: s.maxToolCalls, exclude }
            : undefined,
        context: { title: changeTitle, description: changeDescription, checkDescription: s.checkDescription, extraInstructions: s.extraInstructions, repoInstructions: ctx.repoInstructions },
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
