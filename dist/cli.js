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
exports.main = main;
exports.run = run;
/**
 * Command-line interface: review GitHub PRs or local changes with a self-hosted LLM.
 *
 *   diff-leppard pr 123 --post
 *   diff-leppard local
 *   gh diff-leppard 123          (via the gh extension in ./gh-diff-leppard)
 */
const fs_1 = require("fs");
const path = __importStar(require("path"));
const readline = __importStar(require("readline/promises"));
const util_1 = require("util");
const config_1 = require("./config");
const diff_1 = require("./diff");
const format_1 = require("./format");
const gh_1 = require("./gh");
const git_1 = require("./git");
const github_1 = require("./github");
const llm_1 = require("./llm");
const pr_1 = require("./pr");
const report_1 = require("./report");
const review_1 = require("./review");
const types_1 = require("./types");
const HELP = `diff-leppard — AI code review with your own LLM server (vLLM, Ollama, LM Studio, llama.cpp, …)

Usage:
  diff-leppard pr [<number> | <url> | <owner/repo#number>] [options]
      Review a GitHub pull request. With no argument, reviews the PR for the current branch.
  diff-leppard local [--staged | --base <ref> | --range <a>..<b>] [options]
      Review uncommitted changes in the current git repo; or only staged changes; or everything since
      branching from <ref> (committed + uncommitted, e.g. --base main); or exactly the commits a..b
      (a...b = since their merge-base).
  diff-leppard hook             For pre-commit: staged changes at pre-commit, the pushed commits at pre-push
  diff-leppard models          List models on the configured server
  diff-leppard test            Check the server connection with a tiny request
  diff-leppard config          Show the effective configuration and where it came from

  As a gh extension:  gh diff-leppard [<pr>] [options]   (same options; "gh diff-leppard local" for local changes)

Posting (PR reviews):
      --post                Post the review (as github.reviewEvent from config; default COMMENT)
      --request-changes     Post; request changes if there are critical/major findings
      --draft               Create a pending (draft) review you can edit and submit on GitHub
      --no-prompt           Never ask whether to post (default: ask when running in a terminal)

Output:
  -f, --format <fmt>        text | markdown | json   (default: text in a terminal, markdown when piped)
  -o, --output <file>       Also write the report to a file (.json for JSON, otherwise Markdown)
      --fail-on <severity>  Exit with code 1 if any finding is at or above this severity (for CI)
  -q, --quiet               No progress output
  -v, --verbose             Log requests and decisions to stderr (DIFF_LEPPARD_DEBUG=1 adds prompts and raw model output)

Model server (override config files):
      --base-url <url>      e.g. http://gpu-box:8000/v1 (vLLM) or http://gpu-box:11434 (with --provider ollama)
  -m, --model <name>
      --provider <p>        openai | ollama
      --api-key <key>       (or DIFF_LEPPARD_API_KEY)
      --header <K: V>       Extra request header (repeatable)
      --extra-body <json>   Extra request body fields, e.g. '{"chat_template_kwargs":{"enable_thinking":false}}'
      --json-mode <mode>    json_object | json_schema | none
      --no-stream
      --max-chunk-chars <n>
      --concurrency <n>
      --min-severity <s>    critical | major | minor | nit

Other:
  -R, --repo <owner/repo>   Repository for a bare PR number (default: gh's default repo / git remotes)
  -C, --cwd <dir>           Run as if started in <dir>
      --staged              (local) only staged changes
      --base <ref>          (local) everything since the merge-base with <ref>, e.g. main or origin/main
      --range <a>..<b>      (local) exactly the commits between two refs
  -h, --help
      --version

Config files (JSON, same keys as the VS Code settings without the "diffLeppard." prefix):
  ${(0, config_1.userConfigPath)()}   (user; may contain apiKey)
  <repo>/${config_1.REPO_CONFIG_FILE}   (per repo; only ${config_1.REPO_CONFIG_KEYS.join(', ')}.
      For PR reviews it is read from the PR's base branch, never from the PR itself.)
Environment: every setting as DIFF_LEPPARD_<UPPER_SNAKE_KEY>, e.g. DIFF_LEPPARD_BASE_URL, DIFF_LEPPARD_MODEL, DIFF_LEPPARD_API_KEY,
  DIFF_LEPPARD_EXTRA_BODY (JSON), DIFF_LEPPARD_STREAM=false, DIFF_LEPPARD_GITHUB_REVIEW_EVENT. Also DIFF_LEPPARD_CONFIG (config path)
  and DIFF_LEPPARD_DEBUG=1. GitHub token: GH_TOKEN / GITHUB_TOKEN for github.com, GH_ENTERPRISE_TOKEN for other hosts,
  else \`gh auth token\`.

Exit codes: 0 success · 1 findings at/above --fail-on · 2 error, or the review was incomplete (some parts failed) · 130 cancelled
`;
class UsageError extends Error {
}
/** Version from package.json; works from dist/ (one level down) and out/src/ (two levels). */
function packageVersion() {
    for (const rel of ['../package.json', '../../package.json']) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const pkg = require(rel);
            if (pkg?.name === 'diff-leppard')
                return pkg.version;
        }
        catch {
            /* try the next location */
        }
    }
    return 'unknown';
}
/** Whether a stream is an interactive terminal (decides text vs. Markdown output and the spinner). */
const isTTY = (s) => !!s.isTTY && process.env.TERM !== 'dumb';
/** Whether to use ANSI colors (https://no-color.org: NO_COLOR disables color only). */
const useColor = (s) => isTTY(s) && !process.env.NO_COLOR;
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
function makeLogger(verbose, quiet, progress) {
    const debug = !!process.env.DIFF_LEPPARD_DEBUG;
    const write = (prefix, m) => {
        progress.clear();
        process.stderr.write(`${prefix}${m}\n`);
    };
    return {
        info: (m) => verbose && write('· ', m),
        warn: (m) => !quiet && write('warning: ', m),
        error: (m) => write('error: ', m),
        debug: (m) => debug && write('debug: ', m),
    };
}
class Progress {
    enabled;
    tty;
    last = '';
    lastAt = 0;
    live = false;
    frame = 0;
    constructor(enabled, tty) {
        this.enabled = enabled;
        this.tty = tty;
    }
    update(msg) {
        if (!this.enabled)
            return;
        if (this.tty) {
            const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[this.frame++ % 10];
            const width = (process.stderr.columns || 100) - 4;
            process.stderr.write(`\r\x1b[K${spin} ${msg.slice(0, width)}`);
            this.live = true;
        }
        else {
            const now = Date.now();
            const key = msg.replace(/\d+ chars/, '');
            if (key !== this.last || now - this.lastAt > 15000) {
                process.stderr.write(`${msg}\n`);
                this.last = key;
                this.lastAt = now;
            }
        }
    }
    clear() {
        if (this.live) {
            process.stderr.write('\r\x1b[K');
            this.live = false;
        }
    }
}
async function makeLlm(s, log) {
    const cfg = { ...llmBase(s), model: s.model };
    if (!cfg.model) {
        const models = await new llm_1.LlmClient(cfg, log).listModels();
        if (models.length !== 1) {
            throw new UsageError(models.length
                ? `No model configured and the server has ${models.length}: ${models.join(', ')}. Pass --model or set "model" in ${(0, config_1.userConfigPath)()}.`
                : `The server at ${cfg.baseUrl} reported no models.`);
        }
        cfg.model = models[0];
        log.info(`Using the server's only model: ${cfg.model}`);
    }
    return new llm_1.LlmClient(cfg, log);
}
async function askToPost(label, configured) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
        const a = (await rl.question(`Post this review to ${label}? [y]es / [d]raft / [r]equest changes / [N]o: `)).trim().toLowerCase();
        if (a === 'y' || a === 'yes')
            return configured === 'PENDING' ? 'COMMENT' : configured;
        if (a === 'd' || a === 'draft')
            return 'PENDING';
        if (a === 'r')
            return 'REQUEST_CHANGES_IF_BLOCKING';
        return undefined;
    }
    finally {
        rl.close();
    }
}
async function main(argv) {
    const { values: o, positionals } = (0, util_1.parseArgs)({
        args: argv,
        allowPositionals: true,
        options: {
            post: { type: 'boolean' },
            'request-changes': { type: 'boolean' },
            draft: { type: 'boolean' },
            'no-prompt': { type: 'boolean' },
            format: { type: 'string', short: 'f' },
            output: { type: 'string', short: 'o' },
            'fail-on': { type: 'string' },
            quiet: { type: 'boolean', short: 'q' },
            verbose: { type: 'boolean', short: 'v' },
            'base-url': { type: 'string' },
            model: { type: 'string', short: 'm' },
            provider: { type: 'string' },
            'api-key': { type: 'string' },
            header: { type: 'string', multiple: true },
            'extra-body': { type: 'string' },
            'json-mode': { type: 'string' },
            'no-stream': { type: 'boolean' },
            'max-chunk-chars': { type: 'string' },
            concurrency: { type: 'string' },
            'min-severity': { type: 'string' },
            repo: { type: 'string', short: 'R' },
            cwd: { type: 'string', short: 'C' },
            staged: { type: 'boolean' },
            base: { type: 'string' },
            range: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
            version: { type: 'boolean' },
        },
    });
    if (o.help) {
        process.stdout.write(HELP);
        return 0;
    }
    if (o.version) {
        process.stdout.write(`${packageVersion()}\n`);
        return 0;
    }
    let command = positionals[0] ?? 'pr';
    let rest = positionals.slice(1);
    if (!['pr', 'local', 'staged', 'hook', 'models', 'test', 'config', 'help'].includes(command)) {
        // `diff-leppard 123` / `gh diff-leppard https://…` → pr
        command = 'pr';
        rest = positionals;
    }
    if (command === 'help') {
        process.stdout.write(HELP);
        return 0;
    }
    if (command === 'staged') {
        command = 'local';
        o.staged = true;
    }
    if (command === 'hook') {
        // pre-commit (https://pre-commit.com) exports these for pre-push; otherwise review what's staged.
        const from = process.env.PRE_COMMIT_FROM_REF;
        const to = process.env.PRE_COMMIT_TO_REF;
        if (from && to)
            o.range = `${from}..${to}`;
        else
            o.staged = true;
        o['no-prompt'] = true;
        o.format ??= 'text';
        command = 'local';
    }
    if ([o.staged, o.base, o.range].filter(Boolean).length > 1)
        throw new UsageError('Use only one of --staged, --base and --range');
    const cwd = path.resolve(o.cwd ?? process.cwd());
    const root = await (0, git_1.getRepoRoot)(cwd);
    const flags = {
        baseUrl: o['base-url'],
        model: o.model,
        provider: o.provider,
        apiKey: o['api-key'],
        jsonMode: o['json-mode'],
        stream: o['no-stream'] ? false : undefined,
        maxChunkChars: o['max-chunk-chars'] !== undefined ? Number(o['max-chunk-chars']) : undefined,
        concurrency: o.concurrency !== undefined ? Number(o.concurrency) : undefined,
        minimumSeverity: o['min-severity'],
    };
    if (o['extra-body']) {
        try {
            flags.extraBody = JSON.parse(o['extra-body']);
        }
        catch {
            throw new UsageError('--extra-body must be JSON');
        }
    }
    const headers = {};
    for (const h of o.header ?? []) {
        const i = h.indexOf(':');
        if (i < 1)
            throw new UsageError(`--header must look like "Name: value" (got "${h}")`);
        headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
    }
    const configure = async (repo) => {
        let loaded;
        try {
            loaded = await (0, config_1.loadConfig)(repo, flags);
        }
        catch (e) {
            throw new UsageError(e.message);
        }
        if (Object.keys(headers).length)
            loaded.settings.extraHeaders = { ...loaded.settings.extraHeaders, ...headers };
        return loaded;
    };
    // PR reviews take repo config from the PR's base branch (below); local reviews from the working tree.
    const isPr = !['local', 'models', 'test', 'config'].includes(command);
    let { settings: s, sources, warnings } = await configure(isPr ? undefined : await (0, config_1.readRepoConfig)(root));
    const progress = new Progress(!o.quiet, isTTY(process.stderr));
    const log = makeLogger(!!o.verbose, !!o.quiet, progress);
    for (const src of sources)
        log.info(`config: ${src}`);
    for (const w of warnings)
        log.warn(w);
    if (command === 'config') {
        const redacted = JSON.parse(JSON.stringify(s));
        if (redacted.apiKey)
            redacted.apiKey = '***';
        for (const k of Object.keys(redacted.extraHeaders ?? {}))
            redacted.extraHeaders[k] = '***';
        process.stdout.write(`# sources: ${sources.length ? sources.join(', ') : '(defaults only)'}\n${JSON.stringify(redacted, null, 2)}\n`);
        return 0;
    }
    if (command === 'models') {
        const models = await new llm_1.LlmClient({ ...llmBase(s), model: s.model }, log).listModels();
        process.stdout.write(models.join('\n') + '\n');
        return 0;
    }
    const ac = new AbortController();
    let interrupted = false;
    process.on('SIGINT', () => {
        if (interrupted)
            process.exit(130);
        interrupted = true;
        progress.clear();
        process.stderr.write('Cancelling… (Ctrl-C again to force)\n');
        ac.abort();
    });
    const cancelled = () => {
        progress.clear();
        process.stderr.write('Cancelled.\n');
        return 130;
    };
    if (command === 'test') {
        progress.update(`Connecting to ${s.baseUrl}…`);
        try {
            const llm = await makeLlm(s, log);
            const r = await (0, llm_1.healthCheck)(llm, ac.signal);
            progress.clear();
            process.stdout.write(`✓ ${llm.model} at ${s.baseUrl} replied in ${(r.ms / 1000).toFixed(1)}s: ${r.content.trim().slice(0, 200) || '(empty reply)'}\n`);
            return 0;
        }
        catch (e) {
            if (ac.signal.aborted)
                return cancelled();
            throw e;
        }
    }
    const failOn = o['fail-on'];
    if (failOn && !types_1.SEVERITIES.includes(failOn))
        throw new UsageError(`--fail-on must be one of ${types_1.SEVERITIES.join(', ')}`);
    const format = o.format ?? (isTTY(process.stdout) ? 'text' : 'markdown');
    if (!['text', 'markdown', 'json'].includes(format))
        throw new UsageError('--format must be text, markdown or json');
    const exclude = (0, diff_1.makeExcluder)(s.excludeGlobs);
    const reviewOpts = {
        maxChunkChars: s.maxChunkChars,
        concurrency: s.concurrency,
        minimumSeverity: s.minimumSeverity,
        exclude,
        log,
        signal: ac.signal,
        onProgress: (m) => progress.update(m),
    };
    let result;
    let title;
    let markdown;
    let posting;
    try {
        if (command === 'local') {
            if (!root)
                throw new UsageError(`${cwd} is not inside a git repository`);
            progress.update('Collecting diff…');
            let range;
            if (o.range) {
                const m = /^(.+?)(\.{2,3})(.+)$/.exec(o.range);
                if (!m)
                    throw new UsageError('--range must look like <from>..<to> (or <from>...<to> for "since the merge-base")');
                range = { from: m[1], to: m[3] };
                if (m[2] === '...') {
                    const mb = (await (0, git_1.git)(root, ['merge-base', m[1], m[3]])).trim();
                    if (!mb)
                        throw new UsageError(`No common ancestor between ${m[1]} and ${m[3]}`);
                    range.from = mb;
                }
            }
            let diff;
            try {
                diff = await (0, git_1.getLocalDiff)(root, {
                    stagedOnly: !!o.staged,
                    base: o.base,
                    range,
                    contextLines: s.contextLines,
                    includeUntracked: s.includeUntracked,
                    maxUntrackedBytes: 256 * 1024,
                    exclude,
                });
            }
            catch (e) {
                throw new UsageError(e.message);
            }
            const what = o.range
                ? `commits ${o.range}`
                : o.base
                    ? `changes since ${o.base}`
                    : o.staged
                        ? 'staged changes'
                        : 'uncommitted changes';
            if (!diff.files.length) {
                progress.clear();
                process.stderr.write(`No ${what} in ${path.basename(root)}.\n`);
                return 0;
            }
            const repoInstructions = s.instructionsFile ? await (0, git_1.readRepoFile)(root, s.instructionsFile) : undefined;
            if (repoInstructions)
                log.info(`Using review guidelines from ${s.instructionsFile}`);
            const llm = await makeLlm(s, log);
            result = await (0, review_1.runReview)(diff.files, {
                ...reviewOpts,
                maxChunkChars: await (0, llm_1.resolveChunkChars)(llm, reviewOpts.maxChunkChars, s.maxOutputTokens, log, ac.signal),
                llm,
                context: { extraInstructions: s.extraInstructions, repoInstructions },
                preSkipped: diff.skipped,
            });
            title = `Review of ${what} — ${path.basename(root)}`;
            markdown = () => (0, report_1.renderMarkdownReport)(result, { title, source: `${what[0].toUpperCase()}${what.slice(1)} in **${path.basename(root)}**` });
        }
        else {
            const host = (0, github_1.webHostFromApiUrl)(s.github.apiUrl);
            const arg = rest[0];
            let ref;
            const explicitRepo = o.repo ? /^([^/\s]+)\/([^/\s]+)$/.exec(o.repo) : undefined;
            if (o.repo && !explicitRepo)
                throw new UsageError('--repo must look like owner/repo');
            const fallbackRepo = explicitRepo ? { owner: explicitRepo[1], repo: explicitRepo[2] } : undefined;
            if (arg) {
                ref = (0, github_1.parsePrReference)(arg, host, fallbackRepo ?? (/^#?\d+$/.test(arg) ? await defaultRepo(cwd, root, host) : undefined));
                if (!ref)
                    throw new UsageError(`Can't tell which PR "${arg}" is. Use a number inside a GitHub repo checkout, owner/repo#123, a PR URL, or --repo.`);
            }
            else {
                progress.update('Finding the PR for the current branch…');
                const url = await (0, gh_1.ghExec)(['pr', 'view', '--json', 'url', '-q', '.url'], cwd).catch(() => '');
                ref = url ? (0, github_1.parsePrReference)(url, host) : undefined;
                if (!ref)
                    throw new UsageError('No PR given and no PR found for the current branch. Pass a PR number or URL.');
            }
            const label = `${ref.repo.owner}/${ref.repo.repo}#${ref.number}`;
            progress.update(`Fetching ${label}…`);
            const client = new github_1.GitHubClient(s.github.apiUrl, await (0, gh_1.githubTokenFor)(host), log);
            const pr0 = await client.getPull(ref.repo, ref.number);
            // Repo config from the base branch: a PR can't change how it is itself reviewed.
            const repoCfgText = await client.getFileContent(ref.repo, config_1.REPO_CONFIG_FILE, pr0.baseSha).catch(() => undefined);
            if (repoCfgText !== undefined) {
                let json;
                try {
                    json = (0, config_1.parseJsonc)(repoCfgText);
                }
                catch (e) {
                    throw new UsageError(`Could not parse ${config_1.REPO_CONFIG_FILE} on ${pr0.baseRef}: ${e.message}`);
                }
                if (json && typeof json === 'object' && !Array.isArray(json)) {
                    const source = `${ref.repo.owner}/${ref.repo.repo}@${pr0.baseRef}:${config_1.REPO_CONFIG_FILE}`;
                    ({ settings: s, sources, warnings } = await configure({ json: json, source }));
                    log.info(`config: ${source}`);
                    for (const w of warnings)
                        log.warn(w);
                    reviewOpts.maxChunkChars = s.maxChunkChars;
                    reviewOpts.minimumSeverity = s.minimumSeverity;
                    reviewOpts.exclude = (0, diff_1.makeExcluder)(s.excludeGlobs);
                }
            }
            const loaded = await (0, pr_1.loadPullRequest)(client, ref.repo, ref.number, s.instructionsFile, log, pr0);
            const llm = await makeLlm(s, log);
            result = await (0, review_1.runReview)(loaded.files, {
                ...reviewOpts,
                maxChunkChars: await (0, llm_1.resolveChunkChars)(llm, reviewOpts.maxChunkChars, s.maxOutputTokens, log, ac.signal),
                llm,
                context: { title: loaded.pr.title, description: loaded.pr.body, extraInstructions: s.extraInstructions, repoInstructions: loaded.repoInstructions },
                preSkipped: loaded.skipped,
            });
            const pr = loaded.pr;
            title = `Review of ${label}: ${pr.title}`;
            markdown = () => (0, report_1.renderMarkdownReport)(result, {
                title,
                source: `[${label}](${pr.htmlUrl}) by @${pr.author} (${pr.headRef} → ${pr.baseRef})`,
                blobBaseUrl: `https://${host}/${ref.repo.owner}/${ref.repo.repo}/blob/${pr.headSha}`,
            });
            posting = { client, repo: ref.repo, pr, label };
        }
    }
    catch (e) {
        if (e instanceof review_1.CancelledError || ac.signal.aborted)
            return cancelled();
        throw e;
    }
    progress.clear();
    // Output
    if (format === 'json')
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else if (format === 'markdown')
        process.stdout.write(markdown());
    else
        process.stdout.write((0, format_1.renderTerminal)(result, { color: useColor(process.stdout), title }));
    if (o.output) {
        await fs_1.promises.writeFile(o.output, o.output.endsWith('.json') ? JSON.stringify(result, null, 2) : markdown());
        log.info(`wrote ${o.output}`);
    }
    // Posting
    if (posting) {
        let event = o.draft
            ? 'PENDING'
            : o['request-changes']
                ? 'REQUEST_CHANGES_IF_BLOCKING'
                : o.post
                    ? s.github.reviewEvent
                    : undefined;
        if (!event && !o['no-prompt'] && process.stdin.isTTY && process.stderr.isTTY)
            event = await askToPost(posting.label, s.github.reviewEvent);
        if (event) {
            progress.update('Posting review…');
            const r = await (0, github_1.postReview)(posting.client, posting.repo, posting.pr, result, { event, suggestionBlocks: s.github.suggestionBlocks, attribution: s.github.attribution }, log);
            progress.clear();
            for (const n of r.notes)
                process.stderr.write(`note: ${n}\n`);
            process.stderr.write(`${event === 'PENDING' ? 'Pending review created' : 'Review posted'} (${r.inlineCount} inline comment(s)): ${r.url}\n`);
        }
    }
    if (result.errors.length) {
        process.stderr.write(`error: review incomplete: ${result.errors.length} of ${result.chunkCount} part(s) failed (see above).\n`);
        return 2;
    }
    if (failOn && result.findings.some((f) => (0, types_1.severityRank)(f.severity) <= (0, types_1.severityRank)(failOn)))
        return 1;
    return 0;
}
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
/** Run the CLI and exit the process with its status code. Used by bin/diff-leppard.js and `node dist/cli.js`. */
function run(argv = process.argv.slice(2)) {
    main(argv).then((code) => process.exit(code), (e) => {
        process.stderr.write(`${isTTY(process.stderr) ? '\r\x1b[K' : ''}error: ${e.message}\n`);
        if (e instanceof UsageError || e.code?.startsWith?.('ERR_PARSE_ARGS'))
            process.stderr.write('Run with --help for usage.\n');
        process.exit(e instanceof llm_1.LlmError && e.message === 'Cancelled' ? 130 : 2);
    });
}
if (require.main === module)
    run();
