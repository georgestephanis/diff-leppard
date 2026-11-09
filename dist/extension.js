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
exports.activate = activate;
exports.deactivate = deactivate;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const config_1 = require("./config");
const diff_1 = require("./diff");
const gh_1 = require("./gh");
const git_1 = require("./git");
const github_1 = require("./github");
const llm_1 = require("./llm");
const pr_1 = require("./pr");
const report_1 = require("./report");
const review_1 = require("./review");
const SECRET_KEY = 'diffLeppard.apiKey';
const MAX_UNTRACKED_BYTES = 256 * 1024;
/** Keep this many review reports in global storage. */
const MAX_REPORTS = 20;
function readSettings() {
    const c = vscode.workspace.getConfiguration('diffLeppard');
    // Fallbacks come from the same defaults as the CLI (package.json declares them too, for the Settings UI).
    const d = (0, config_1.defaultSettings)();
    return {
        llm: {
            provider: c.get('provider', d.provider),
            baseUrl: c.get('baseUrl', d.baseUrl),
            model: c.get('model', d.model).trim(),
            temperature: c.get('temperature', d.temperature),
            maxOutputTokens: c.get('maxOutputTokens', d.maxOutputTokens),
            jsonMode: c.get('jsonMode', d.jsonMode),
            stream: c.get('stream', d.stream),
            timeoutMs: c.get('requestTimeoutSeconds', d.requestTimeoutSeconds) * 1000,
            ollamaNumCtx: c.get('ollamaNumCtx', d.ollamaNumCtx),
            extraHeaders: c.get('extraHeaders', d.extraHeaders),
            extraBody: c.get('extraBody', d.extraBody),
        },
        maxChunkChars: c.get('maxChunkChars', d.maxChunkChars),
        contextLines: c.get('contextLines', d.contextLines),
        includeUntracked: c.get('includeUntracked', d.includeUntracked),
        minimumSeverity: c.get('minimumSeverity', d.minimumSeverity),
        excludeGlobs: c.get('excludeGlobs', d.excludeGlobs),
        extraInstructions: c.get('extraInstructions', d.extraInstructions),
        instructionsFile: c.get('instructionsFile', d.instructionsFile).trim(),
        concurrency: c.get('concurrency', d.concurrency),
        showStatusBar: c.get('showStatusBar', true),
        github: {
            apiUrl: c.get('github.apiUrl', d.github.apiUrl),
            auth: c.get('github.auth', 'vscode'),
            postReview: c.get('github.postReview', 'ask'),
            reviewEvent: c.get('github.reviewEvent', d.github.reviewEvent),
            suggestionBlocks: c.get('github.suggestionBlocks', d.github.suggestionBlocks),
            attribution: c.get('github.attribution', d.github.attribution),
        },
    };
}
class Controller {
    ctx;
    log;
    logger;
    diagnostics;
    status;
    running = false;
    last;
    constructor(ctx) {
        this.ctx = ctx;
        this.log = vscode.window.createOutputChannel('Diff Leppard', { log: true });
        this.logger = {
            info: (m) => this.log.info(m),
            warn: (m) => this.log.warn(m),
            error: (m) => this.log.error(m),
            debug: (m) => this.log.debug(m),
        };
        this.diagnostics = vscode.languages.createDiagnosticCollection('diffLeppard');
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
        this.status.command = 'diffLeppard.showMenu';
        ctx.subscriptions.push(this.log, this.diagnostics, this.status);
        this.updateStatus();
        ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('diffLeppard') && this.updateStatus()));
    }
    updateStatus() {
        const s = readSettings();
        if (this.running) {
            this.status.text = '$(sync~spin) Reviewing…';
            this.status.tooltip = 'Diff Leppard is running';
        }
        else {
            this.status.text = '$(checklist) Review';
            this.status.tooltip = `Diff Leppard — ${s.llm.model || '(no model selected)'} @ ${s.llm.baseUrl}`;
        }
        if (s.showStatusBar || this.running)
            this.status.show();
        else
            this.status.hide();
    }
    // -------------------------------------------------------------------------
    // LLM
    // -------------------------------------------------------------------------
    async llmConfig() {
        const s = readSettings();
        return { ...s.llm, apiKey: (await this.ctx.secrets.get(SECRET_KEY)) || undefined };
    }
    /** Builds a client, asking the user to pick a model if none is configured. */
    async llmClient() {
        const cfg = await this.llmConfig();
        if (cfg.model)
            return new llm_1.LlmClient(cfg, this.logger);
        const models = await new llm_1.LlmClient(cfg, this.logger).listModels();
        if (!models.length)
            throw new Error(`The server at ${cfg.baseUrl} reported no models.`);
        if (models.length === 1) {
            cfg.model = models[0];
            this.log.info(`No model configured; using the only one available: ${cfg.model}`);
            return new llm_1.LlmClient(cfg, this.logger);
        }
        const picked = await this.pickModel(models);
        if (!picked)
            return undefined;
        cfg.model = picked;
        return new llm_1.LlmClient(cfg, this.logger);
    }
    async pickModel(models) {
        const current = readSettings().llm.model;
        const picked = await vscode.window.showQuickPick(models.map((m) => ({ label: m, description: m === current ? 'current' : undefined })), { title: 'Select the model to use for code reviews', placeHolder: 'Model' });
        if (!picked)
            return undefined;
        const c = vscode.workspace.getConfiguration('diffLeppard');
        const insp = c.inspect('model');
        const target = insp?.workspaceFolderValue !== undefined
            ? vscode.ConfigurationTarget.WorkspaceFolder
            : insp?.workspaceValue !== undefined
                ? vscode.ConfigurationTarget.Workspace
                : vscode.ConfigurationTarget.Global;
        await c.update('model', picked.label, target);
        return picked.label;
    }
    async selectModel() {
        const cfg = await this.llmConfig();
        const models = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Listing models at ${cfg.baseUrl}…` }, () => new llm_1.LlmClient(cfg, this.logger).listModels());
        if (!models.length) {
            vscode.window.showWarningMessage(`The server at ${cfg.baseUrl} reported no models.`);
            return;
        }
        const m = await this.pickModel(models);
        if (m)
            vscode.window.showInformationMessage(`Diff Leppard will use ${m}.`);
    }
    async testConnection() {
        const cfg = await this.llmConfig();
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Testing LLM connection…', cancellable: true }, async (_p, token) => {
            const ac = new AbortController();
            token.onCancellationRequested(() => ac.abort());
            const probe = new llm_1.LlmClient(cfg, this.logger);
            const models = await probe.listModels(ac.signal);
            this.log.info(`Models at ${cfg.baseUrl}: ${models.join(', ') || '(none)'}`);
            const model = cfg.model || models[0];
            if (!model)
                throw new Error('Server reachable but it reports no models.');
            if (cfg.model && models.length && !models.includes(cfg.model)) {
                vscode.window.showWarningMessage(`Model "${cfg.model}" is not in the server's model list: ${models.join(', ')}`);
            }
            const r = await (0, llm_1.healthCheck)(new llm_1.LlmClient({ ...cfg, model }, this.logger), ac.signal);
            this.log.info(`Test reply from ${model} in ${r.ms}ms: ${r.content}`);
            vscode.window.showInformationMessage(`✓ ${model} replied in ${(r.ms / 1000).toFixed(1)}s (${models.length} model(s) available).`);
        });
    }
    async setApiKey() {
        const v = await vscode.window.showInputBox({
            title: 'LLM API key',
            prompt: 'Sent as "Authorization: Bearer <key>". Leave empty to remove the stored key.',
            password: true,
            ignoreFocusOut: true,
        });
        if (v === undefined)
            return;
        if (v.trim()) {
            await this.ctx.secrets.store(SECRET_KEY, v.trim());
            vscode.window.showInformationMessage('API key saved to VS Code secret storage.');
        }
        else {
            await this.ctx.secrets.delete(SECRET_KEY);
            vscode.window.showInformationMessage('API key removed.');
        }
    }
    // -------------------------------------------------------------------------
    // Repos & GitHub
    // -------------------------------------------------------------------------
    async pickRepoRoot(required) {
        const dirs = [];
        const active = vscode.window.activeTextEditor?.document.uri;
        if (active?.scheme === 'file')
            dirs.push(path.dirname(active.fsPath));
        for (const f of vscode.workspace.workspaceFolders ?? [])
            if (f.uri.scheme === 'file')
                dirs.push(f.uri.fsPath);
        const roots = [];
        for (const d of dirs) {
            const r = await (0, git_1.getRepoRoot)(d);
            if (!r)
                continue;
            // git returns the resolved path (/private/var/... for /var/...); express the root the way the
            // workspace spells it so diagnostics attach to the documents VS Code has open.
            let root = r;
            try {
                const rel = path.relative(r, fs.realpathSync(d));
                const candidate = rel ? path.resolve(d, ...rel.split(path.sep).map(() => '..')) : d;
                if (!rel.startsWith('..') && fs.realpathSync(candidate) === fs.realpathSync(r))
                    root = candidate;
            }
            catch {
                /* keep git's path */
            }
            if (!roots.includes(root))
                roots.push(root);
        }
        if (!roots.length) {
            if (required)
                throw new Error('No git repository found in this workspace.');
            return undefined;
        }
        if (roots.length === 1)
            return roots[0];
        const picked = await vscode.window.showQuickPick(roots.map((r) => ({ label: path.basename(r), description: r, root: r })), { title: 'Which repository?' });
        return picked?.root;
    }
    async githubToken(s) {
        const host = (0, github_1.webHostFromApiUrl)(s.github.apiUrl);
        if (s.github.auth === 'gh-cli') {
            const tok = await (0, gh_1.ghExec)(['auth', 'token', '--hostname', host]).catch(() => '');
            if (tok)
                return tok;
            throw new Error(`Could not get a token from the GitHub CLI. Run "gh auth login --hostname ${host}".`);
        }
        const provider = host === 'github.com' ? 'github' : 'github-enterprise';
        const session = await vscode.authentication.getSession(provider, ['repo'], { createIfNone: true });
        return session.accessToken;
    }
    async choosePr(gh, host, repos) {
        let repo;
        if (repos.length > 1) {
            const p = await vscode.window.showQuickPick(repos.map((r) => ({ label: `${r.repo.owner}/${r.repo.repo}`, description: r.remote, repo: r.repo })), { title: 'Review a pull request from which repository?' });
            if (!p)
                return undefined;
            repo = p.repo;
        }
        else
            repo = repos[0]?.repo;
        const qp = vscode.window.createQuickPick();
        qp.title = repo ? `Open pull requests in ${repo.owner}/${repo.repo}` : 'Review a GitHub pull request';
        qp.placeholder = repo ? 'Pick a PR, or type a PR number / URL' : 'Type a PR URL (https://github.com/owner/repo/pull/123) or owner/repo#123';
        qp.matchOnDescription = true;
        let prItems = [];
        const typedItem = (v) => {
            const ref = (0, github_1.parsePrReference)(v, host, repo);
            return ref ? [{ label: `$(git-pull-request) Review ${ref.repo.owner}/${ref.repo.repo}#${ref.number}`, alwaysShow: true, pick: ref }] : [];
        };
        qp.onDidChangeValue((v) => (qp.items = [...typedItem(v), ...prItems]));
        if (repo) {
            qp.busy = true;
            gh.listOpenPulls(repo)
                .then((prs) => {
                prItems = prs.map((p) => ({
                    label: `#${p.number} ${p.title}`,
                    description: `${p.author} · ${p.headRef}${p.draft ? ' · draft' : ''}`,
                    pick: { repo: repo, number: p.number },
                }));
                qp.items = [...typedItem(qp.value), ...prItems];
            })
                .catch((e) => {
                this.log.warn(`Could not list PRs: ${e.message}`);
                qp.placeholder = 'Could not list PRs — type a PR number or URL';
            })
                .finally(() => (qp.busy = false));
        }
        return new Promise((resolve) => {
            let result;
            qp.onDidAccept(() => {
                result = qp.selectedItems[0]?.pick ?? (0, github_1.parsePrReference)(qp.value, host, repo);
                if (result)
                    qp.hide();
            });
            qp.onDidHide(() => {
                qp.dispose();
                resolve(result);
            });
            qp.show();
        });
    }
    // -------------------------------------------------------------------------
    // Reviews
    // -------------------------------------------------------------------------
    async withReviewProgress(title, fn) {
        if (this.running) {
            vscode.window.showWarningMessage('A review is already running.');
            return undefined;
        }
        this.running = true;
        this.updateStatus();
        try {
            return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
                const ac = new AbortController();
                token.onCancellationRequested(() => ac.abort());
                return fn(ac.signal, (message, increment) => progress.report({ message, increment }));
            });
        }
        finally {
            this.running = false;
            this.updateStatus();
        }
    }
    async reviewLocal(stagedOnly) {
        const s = readSettings();
        const root = await this.pickRepoRoot(true);
        if (!root)
            return;
        const llm = await this.llmClient();
        if (!llm)
            return;
        const exclude = (0, diff_1.makeExcluder)(s.excludeGlobs);
        const what = stagedOnly ? 'staged changes' : 'uncommitted changes';
        this.log.info(`=== Reviewing ${what} in ${root}`);
        const result = await this.withReviewProgress(`Diff Leppard: ${what}`, async (signal, report) => {
            report('Collecting diff…');
            const diff = await (0, git_1.getLocalDiff)(root, {
                stagedOnly,
                contextLines: s.contextLines,
                includeUntracked: s.includeUntracked,
                maxUntrackedBytes: MAX_UNTRACKED_BYTES,
                exclude,
            });
            if (!diff.files.length) {
                vscode.window.showInformationMessage(`No ${what} to review in ${path.basename(root)}.`);
                return undefined;
            }
            const repoInstructions = s.instructionsFile ? await (0, git_1.readRepoFile)(root, s.instructionsFile) : undefined;
            if (repoInstructions)
                this.log.info(`Using review guidelines from ${s.instructionsFile}`);
            return (0, review_1.runReview)(diff.files, {
                llm,
                maxChunkChars: await (0, llm_1.resolveChunkChars)(llm, s.maxChunkChars, s.llm.maxOutputTokens, this.logger, signal),
                concurrency: s.concurrency,
                minimumSeverity: s.minimumSeverity,
                exclude,
                context: { extraInstructions: s.extraInstructions, repoInstructions },
                log: this.logger,
                signal,
                onProgress: report,
                preSkipped: diff.skipped,
            });
        });
        if (!result)
            return;
        const meta = {
            title: `Review of ${what} — ${path.basename(root)}`,
            source: `${stagedOnly ? 'Staged' : 'Uncommitted'} changes in **${path.basename(root)}**`,
            repoRoot: root,
        };
        this.setDiagnostics(result, root);
        await this.finish(result, meta);
    }
    async reviewPullRequest(arg) {
        const s = readSettings();
        const host = (0, github_1.webHostFromApiUrl)(s.github.apiUrl);
        const root = await this.pickRepoRoot(false);
        const repos = await (0, gh_1.githubRemotes)(root, host);
        const token = await this.githubToken(s);
        const gh = new github_1.GitHubClient(s.github.apiUrl, token, this.logger);
        const ref = typeof arg === 'string' || typeof arg === 'number'
            ? (0, github_1.parsePrReference)(String(arg), host, repos[0]?.repo)
            : await this.choosePr(gh, host, repos);
        if (!ref)
            return;
        const llm = await this.llmClient();
        if (!llm)
            return;
        const exclude = (0, diff_1.makeExcluder)(s.excludeGlobs);
        const label = `${ref.repo.owner}/${ref.repo.repo}#${ref.number}`;
        this.log.info(`=== Reviewing ${label}`);
        const out = await this.withReviewProgress(`Diff Leppard: ${label}`, async (signal, report) => {
            report('Fetching pull request…');
            const { pr, files, skipped, repoInstructions } = await (0, pr_1.loadPullRequest)(gh, ref.repo, ref.number, s.instructionsFile, this.logger);
            const result = await (0, review_1.runReview)(files, {
                llm,
                maxChunkChars: await (0, llm_1.resolveChunkChars)(llm, s.maxChunkChars, s.llm.maxOutputTokens, this.logger, signal),
                concurrency: s.concurrency,
                minimumSeverity: s.minimumSeverity,
                exclude,
                context: { title: pr.title, description: pr.body, extraInstructions: s.extraInstructions, repoInstructions },
                log: this.logger,
                signal,
                onProgress: report,
                preSkipped: skipped,
            });
            return { pr, result };
        });
        if (!out)
            return;
        const { pr, result } = out;
        // Show findings in the Problems panel only if the PR head is what's checked out locally.
        const localMatches = !!root &&
            repos.some((r) => r.repo.owner === ref.repo.owner && r.repo.repo === ref.repo.repo) &&
            (await (0, git_1.getHeadSha)(root)) === pr.headSha;
        if (localMatches)
            this.setDiagnostics(result, root);
        else
            this.diagnostics.clear();
        const meta = {
            title: `Review of ${label}: ${pr.title}`,
            source: `[${label}](${pr.htmlUrl}) by @${pr.author} (${pr.headRef} → ${pr.baseRef})`,
            repoRoot: localMatches ? root : undefined,
            blobBaseUrl: `https://${host}/${ref.repo.owner}/${ref.repo.repo}/blob/${pr.headSha}`,
        };
        await this.finish(result, meta, { repo: ref.repo, info: pr, apiUrl: s.github.apiUrl });
        if (s.github.postReview === 'always') {
            await this.post(s.github.reviewEvent);
        }
        else if (s.github.postReview === 'ask') {
            const inline = result.findings.filter((f) => f.inline).length;
            const choice = await vscode.window.showInformationMessage(`Review of ${label} done: ${result.findings.length} finding(s), ${inline} on changed lines. Post it to GitHub?`, 'Post review', 'Post as draft (pending)', 'Not now');
            if (choice === 'Post review')
                await this.post(s.github.reviewEvent === 'PENDING' ? 'COMMENT' : s.github.reviewEvent);
            else if (choice === 'Post as draft (pending)')
                await this.post('PENDING');
        }
    }
    async postLast() {
        if (!this.last?.pr) {
            vscode.window.showWarningMessage('Run "Review GitHub Pull Request" first.');
            return;
        }
        const s = readSettings();
        const choice = await vscode.window.showQuickPick([
            { label: 'Comment', event: 'COMMENT' },
            { label: 'Request changes if there are critical/major findings', event: 'REQUEST_CHANGES_IF_BLOCKING' },
            { label: 'Pending (draft) review — edit and submit it on GitHub', event: 'PENDING' },
        ].map((o) => ({ ...o, description: o.event === s.github.reviewEvent ? 'default' : undefined })), { title: `Post review to ${this.last.pr.repo.owner}/${this.last.pr.repo.repo}#${this.last.pr.info.number}` });
        if (choice)
            await this.post(choice.event);
    }
    async post(event) {
        const last = this.last;
        if (!last?.pr)
            return;
        const s = readSettings();
        const gh = new github_1.GitHubClient(last.pr.apiUrl, await this.githubToken(s), this.logger);
        const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Posting review to GitHub…' }, () => (0, github_1.postReview)(gh, last.pr.repo, last.pr.info, last.result, { event, suggestionBlocks: s.github.suggestionBlocks, attribution: s.github.attribution }, this.logger));
        for (const n of r.notes)
            this.log.warn(n);
        this.log.info(`Posted review: ${r.url}`);
        last.meta.postedUrl = r.url;
        await vscode.workspace.fs.writeFile(last.reportUri, Buffer.from((0, report_1.renderMarkdownReport)(last.result, last.meta), 'utf8'));
        const msg = `${event === 'PENDING' ? 'Pending review created' : 'Review posted'} with ${r.inlineCount} inline comment(s).${r.notes.length ? ' ' + r.notes.join(' ') : ''}`;
        const open = await vscode.window.showInformationMessage(msg, 'Open on GitHub');
        if (open)
            vscode.env.openExternal(vscode.Uri.parse(r.url));
    }
    async finish(result, meta, pr) {
        this.log.info(`Done in ${(result.durationMs / 1000).toFixed(1)}s: ${result.findings.length} finding(s), ${result.errors.length} error(s)`);
        const dir = vscode.Uri.joinPath(this.ctx.globalStorageUri, 'reports');
        await vscode.workspace.fs.createDirectory(dir);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const slug = meta.title.replace(/[^\w-]+/g, '-').replace(/-+/g, '-').slice(0, 60);
        const reportUri = vscode.Uri.joinPath(dir, `${stamp}-${slug}.md`);
        meta.reportDir = dir.fsPath;
        await vscode.workspace.fs.writeFile(reportUri, Buffer.from((0, report_1.renderMarkdownReport)(result, meta), 'utf8'));
        this.last = { result, meta, reportUri, pr };
        await this.pruneReports(dir);
        await vscode.commands.executeCommand('setContext', 'diffLeppard.hasReview', true);
        await vscode.commands.executeCommand('setContext', 'diffLeppard.hasPrReview', !!pr);
        await this.openReport();
        if (result.errors.length) {
            vscode.window
                .showWarningMessage(`${result.errors.length} part(s) of the diff failed to review.`, 'Show Log')
                .then((c) => c && this.log.show());
        }
    }
    /** Keep only the newest MAX_REPORTS reports (names start with an ISO timestamp, so they sort by age). */
    async pruneReports(dir) {
        try {
            const names = (await vscode.workspace.fs.readDirectory(dir))
                .filter(([n, t]) => t === vscode.FileType.File && n.endsWith('.md'))
                .map(([n]) => n)
                .sort();
            for (const n of names.slice(0, Math.max(0, names.length - MAX_REPORTS))) {
                await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, n));
            }
        }
        catch (e) {
            this.log.debug(`Could not prune old reports: ${e.message}`);
        }
    }
    async openReport() {
        if (!this.last)
            return;
        await vscode.commands.executeCommand('markdown.showPreviewToSide', this.last.reportUri);
    }
    setDiagnostics(result, root) {
        this.diagnostics.clear();
        const byFile = new Map();
        const sev = {
            critical: vscode.DiagnosticSeverity.Error,
            major: vscode.DiagnosticSeverity.Warning,
            minor: vscode.DiagnosticSeverity.Information,
            nit: vscode.DiagnosticSeverity.Hint,
        };
        for (const f of result.findings) {
            if (f.file.startsWith('('))
                continue;
            const start = Math.max(0, (f.line ?? 1) - 1);
            const end = Math.max(start, (f.endLine ?? f.line ?? 1) - 1);
            const d = new vscode.Diagnostic(new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER), `[${f.severity}] ${f.title}${f.body && f.body !== f.title ? `\n\n${f.body}` : ''}${f.suggestion ? `\n\nSuggested change:\n${f.suggestion}` : ''}`, sev[f.severity]);
            d.source = 'Diff Leppard';
            if (f.category)
                d.code = f.category;
            const abs = path.join(root, f.file);
            if (!byFile.has(abs))
                byFile.set(abs, []);
            byFile.get(abs).push(d);
        }
        for (const [file, diags] of byFile)
            this.diagnostics.set(vscode.Uri.file(file), diags);
    }
    clear() {
        this.diagnostics.clear();
    }
    async menu() {
        const items = [
            { label: '$(checklist) Review uncommitted changes', cmd: 'diffLeppard.reviewUncommitted' },
            { label: '$(diff-added) Review staged changes', cmd: 'diffLeppard.reviewStaged' },
            { label: '$(git-pull-request) Review a GitHub pull request…', cmd: 'diffLeppard.reviewPullRequest' },
        ];
        if (this.last)
            items.push({ label: '$(preview) Open last report', cmd: 'diffLeppard.openLastReport' });
        if (this.last?.pr)
            items.push({ label: '$(comment-discussion) Post last review to GitHub', cmd: 'diffLeppard.postLastReview' });
        items.push({ label: '$(clear-all) Clear findings', cmd: 'diffLeppard.clearFindings' }, { label: '$(server) Select model', cmd: 'diffLeppard.selectModel', description: readSettings().llm.model }, { label: '$(plug) Test LLM connection', cmd: 'diffLeppard.testConnection' }, { label: '$(gear) Settings', cmd: 'diffLeppard.openSettings' });
        const p = await vscode.window.showQuickPick(items, { title: 'Diff Leppard' });
        if (p)
            await vscode.commands.executeCommand(p.cmd);
    }
    /** Wrap a command so errors surface as notifications with a "Show Log" button. */
    wrap(fn) {
        return async (...args) => {
            try {
                await fn(...args);
            }
            catch (e) {
                if (e instanceof review_1.CancelledError || e.message === 'Cancelled') {
                    vscode.window.showInformationMessage('Review cancelled.');
                    return;
                }
                const msg = e.message ?? String(e);
                this.log.error(msg);
                const c = await vscode.window.showErrorMessage(`Diff Leppard: ${msg}`, 'Show Log', 'Settings');
                if (c === 'Show Log')
                    this.log.show();
                else if (c === 'Settings')
                    vscode.commands.executeCommand('diffLeppard.openSettings');
            }
        };
    }
}
function activate(context) {
    const c = new Controller(context);
    const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, c.wrap(fn)));
    reg('diffLeppard.reviewUncommitted', () => c.reviewLocal(false));
    reg('diffLeppard.reviewStaged', () => c.reviewLocal(true));
    reg('diffLeppard.reviewPullRequest', (arg) => c.reviewPullRequest(arg));
    reg('diffLeppard.postLastReview', () => c.postLast());
    reg('diffLeppard.openLastReport', () => c.openReport());
    reg('diffLeppard.selectModel', () => c.selectModel());
    reg('diffLeppard.testConnection', () => c.testConnection());
    reg('diffLeppard.setApiKey', () => c.setApiKey());
    reg('diffLeppard.clearFindings', () => c.clear());
    reg('diffLeppard.showMenu', () => c.menu());
    reg('diffLeppard.openSettings', async () => {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:georgestephanis.diff-leppard');
    });
}
function deactivate() { }
