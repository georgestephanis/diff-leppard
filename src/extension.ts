import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { makeExcluder } from './diff';
import { getHeadSha, getLocalDiff, getRemotes, getRepoRoot, readRepoFile } from './git';
import {
  GitHubClient,
  parsePrReference,
  parseRemoteUrl,
  postReview,
  PullRequestInfo,
  RepoRef,
  ReviewEventSetting,
  webHostFromApiUrl,
} from './github';
import { JsonMode, LlmClient, LlmConfig } from './llm';
import { renderMarkdownReport, ReportMeta } from './report';
import { CancelledError, runReview } from './review';
import { Logger, ReviewResult, Severity } from './types';

const SECRET_KEY = 'localCodeReview.apiKey';
const MAX_UNTRACKED_BYTES = 256 * 1024;

interface Settings {
  llm: Omit<LlmConfig, 'apiKey'>;
  maxChunkChars: number;
  contextLines: number;
  includeUntracked: boolean;
  minimumSeverity: Severity;
  excludeGlobs: string[];
  extraInstructions: string;
  instructionsFile: string;
  concurrency: number;
  showStatusBar: boolean;
  github: {
    apiUrl: string;
    auth: 'vscode' | 'gh-cli';
    postReview: 'ask' | 'always' | 'never';
    reviewEvent: ReviewEventSetting;
    suggestionBlocks: boolean;
  };
}

function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('localCodeReview');
  return {
    llm: {
      provider: c.get<'openai' | 'ollama'>('provider', 'openai'),
      baseUrl: c.get<string>('baseUrl', 'http://localhost:8000/v1'),
      model: c.get<string>('model', '').trim(),
      temperature: c.get<number>('temperature', 0.1),
      maxOutputTokens: c.get<number>('maxOutputTokens', 4096),
      jsonMode: c.get<JsonMode>('jsonMode', 'json_object'),
      stream: c.get<boolean>('stream', true),
      timeoutMs: c.get<number>('requestTimeoutSeconds', 900) * 1000,
      ollamaNumCtx: c.get<number>('ollamaNumCtx', 16384),
      extraHeaders: c.get<Record<string, string>>('extraHeaders', {}),
      extraBody: c.get<Record<string, unknown>>('extraBody', {}),
    },
    maxChunkChars: c.get<number>('maxChunkChars', 24000),
    contextLines: c.get<number>('contextLines', 5),
    includeUntracked: c.get<boolean>('includeUntracked', true),
    minimumSeverity: c.get<Severity>('minimumSeverity', 'minor'),
    excludeGlobs: c.get<string[]>('excludeGlobs', []),
    extraInstructions: c.get<string>('extraInstructions', ''),
    instructionsFile: c.get<string>('instructionsFile', '').trim(),
    concurrency: c.get<number>('concurrency', 1),
    showStatusBar: c.get<boolean>('showStatusBar', true),
    github: {
      apiUrl: c.get<string>('github.apiUrl', 'https://api.github.com'),
      auth: c.get<'vscode' | 'gh-cli'>('github.auth', 'vscode'),
      postReview: c.get<'ask' | 'always' | 'never'>('github.postReview', 'ask'),
      reviewEvent: c.get<ReviewEventSetting>('github.reviewEvent', 'COMMENT'),
      suggestionBlocks: c.get<boolean>('github.suggestionBlocks', false),
    },
  };
}

interface LastReview {
  result: ReviewResult;
  meta: ReportMeta;
  reportUri: vscode.Uri;
  pr?: { repo: RepoRef; info: PullRequestInfo; apiUrl: string };
}

class Controller {
  private readonly log: vscode.LogOutputChannel;
  private readonly logger: Logger;
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly status: vscode.StatusBarItem;
  private running = false;
  private last?: LastReview;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.log = vscode.window.createOutputChannel('Local Code Review', { log: true });
    this.logger = {
      info: (m) => this.log.info(m),
      warn: (m) => this.log.warn(m),
      error: (m) => this.log.error(m),
      debug: (m) => this.log.debug(m),
    };
    this.diagnostics = vscode.languages.createDiagnosticCollection('localCodeReview');
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'localCodeReview.showMenu';
    ctx.subscriptions.push(this.log, this.diagnostics, this.status);
    this.updateStatus();
    ctx.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('localCodeReview') && this.updateStatus()),
    );
  }

  private updateStatus(): void {
    const s = readSettings();
    if (this.running) {
      this.status.text = '$(sync~spin) Reviewing…';
      this.status.tooltip = 'Local Code Review is running';
    } else {
      this.status.text = '$(checklist) Review';
      this.status.tooltip = `Local Code Review — ${s.llm.model || '(no model selected)'} @ ${s.llm.baseUrl}`;
    }
    if (s.showStatusBar || this.running) this.status.show();
    else this.status.hide();
  }

  // -------------------------------------------------------------------------
  // LLM
  // -------------------------------------------------------------------------

  private async llmConfig(): Promise<LlmConfig> {
    const s = readSettings();
    return { ...s.llm, apiKey: (await this.ctx.secrets.get(SECRET_KEY)) || undefined };
  }

  /** Builds a client, asking the user to pick a model if none is configured. */
  private async llmClient(): Promise<LlmClient | undefined> {
    const cfg = await this.llmConfig();
    if (cfg.model) return new LlmClient(cfg, this.logger);
    const models = await new LlmClient(cfg, this.logger).listModels();
    if (!models.length) throw new Error(`The server at ${cfg.baseUrl} reported no models.`);
    if (models.length === 1) {
      cfg.model = models[0];
      this.log.info(`No model configured; using the only one available: ${cfg.model}`);
      return new LlmClient(cfg, this.logger);
    }
    const picked = await this.pickModel(models);
    if (!picked) return undefined;
    cfg.model = picked;
    return new LlmClient(cfg, this.logger);
  }

  private async pickModel(models: string[]): Promise<string | undefined> {
    const current = readSettings().llm.model;
    const picked = await vscode.window.showQuickPick(
      models.map((m) => ({ label: m, description: m === current ? 'current' : undefined })),
      { title: 'Select the model to use for code reviews', placeHolder: 'Model' },
    );
    if (!picked) return undefined;
    const c = vscode.workspace.getConfiguration('localCodeReview');
    const insp = c.inspect<string>('model');
    const target =
      insp?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : insp?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    await c.update('model', picked.label, target);
    return picked.label;
  }

  async selectModel(): Promise<void> {
    const cfg = await this.llmConfig();
    const models = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Listing models at ${cfg.baseUrl}…` },
      () => new LlmClient(cfg, this.logger).listModels(),
    );
    if (!models.length) {
      vscode.window.showWarningMessage(`The server at ${cfg.baseUrl} reported no models.`);
      return;
    }
    const m = await this.pickModel(models);
    if (m) vscode.window.showInformationMessage(`Local Code Review will use ${m}.`);
  }

  async testConnection(): Promise<void> {
    const cfg = await this.llmConfig();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Testing LLM connection…', cancellable: true },
      async (_p, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        const probe = new LlmClient(cfg, this.logger);
        const models = await probe.listModels(ac.signal);
        this.log.info(`Models at ${cfg.baseUrl}: ${models.join(', ') || '(none)'}`);
        const model = cfg.model || models[0];
        if (!model) throw new Error('Server reachable but it reports no models.');
        if (cfg.model && models.length && !models.includes(cfg.model)) {
          vscode.window.showWarningMessage(`Model "${cfg.model}" is not in the server's model list: ${models.join(', ')}`);
        }
        const client = new LlmClient({ ...cfg, model, maxOutputTokens: 64 }, this.logger);
        const t0 = Date.now();
        const res = await client.chat(
          [
            { role: 'system', content: 'You are a health check. Respond with JSON only.' },
            { role: 'user', content: 'Respond with exactly {"ok": true}' },
          ],
          { signal: ac.signal, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
        );
        this.log.info(`Test reply from ${model} in ${Date.now() - t0}ms: ${res.content}`);
        vscode.window.showInformationMessage(
          `✓ ${model} replied in ${((Date.now() - t0) / 1000).toFixed(1)}s (${models.length} model(s) available).`,
        );
      },
    );
  }

  async setApiKey(): Promise<void> {
    const v = await vscode.window.showInputBox({
      title: 'LLM API key',
      prompt: 'Sent as "Authorization: Bearer <key>". Leave empty to remove the stored key.',
      password: true,
      ignoreFocusOut: true,
    });
    if (v === undefined) return;
    if (v.trim()) {
      await this.ctx.secrets.store(SECRET_KEY, v.trim());
      vscode.window.showInformationMessage('API key saved to VS Code secret storage.');
    } else {
      await this.ctx.secrets.delete(SECRET_KEY);
      vscode.window.showInformationMessage('API key removed.');
    }
  }

  // -------------------------------------------------------------------------
  // Repos & GitHub
  // -------------------------------------------------------------------------

  private async pickRepoRoot(required: boolean): Promise<string | undefined> {
    const dirs: string[] = [];
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === 'file') dirs.push(path.dirname(active.fsPath));
    for (const f of vscode.workspace.workspaceFolders ?? []) if (f.uri.scheme === 'file') dirs.push(f.uri.fsPath);
    const roots: string[] = [];
    for (const d of dirs) {
      const r = await getRepoRoot(d);
      if (!r) continue;
      // git returns the resolved path (/private/var/... for /var/...); express the root the way the
      // workspace spells it so diagnostics attach to the documents VS Code has open.
      let root = r;
      try {
        const rel = path.relative(r, fs.realpathSync(d));
        const candidate = rel ? path.resolve(d, ...rel.split(path.sep).map(() => '..')) : d;
        if (!rel.startsWith('..') && fs.realpathSync(candidate) === fs.realpathSync(r)) root = candidate;
      } catch {
        /* keep git's path */
      }
      if (!roots.includes(root)) roots.push(root);
    }
    if (!roots.length) {
      if (required) throw new Error('No git repository found in this workspace.');
      return undefined;
    }
    if (roots.length === 1) return roots[0];
    const picked = await vscode.window.showQuickPick(
      roots.map((r) => ({ label: path.basename(r), description: r, root: r })),
      { title: 'Which repository?' },
    );
    return picked?.root;
  }

  private async githubToken(s: Settings): Promise<string> {
    const host = webHostFromApiUrl(s.github.apiUrl);
    if (s.github.auth === 'gh-cli') {
      for (const bin of ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
        const tok = await new Promise<string>((resolve) =>
          execFile(bin, ['auth', 'token', '--hostname', host], (err, out) => resolve(err ? '' : out.trim())),
        );
        if (tok) return tok;
      }
      throw new Error(`Could not get a token from the GitHub CLI. Run "gh auth login --hostname ${host}".`);
    }
    const provider = host === 'github.com' ? 'github' : 'github-enterprise';
    const session = await vscode.authentication.getSession(provider, ['repo'], { createIfNone: true });
    return session.accessToken;
  }

  private async githubReposFor(root: string | undefined, host: string): Promise<{ remote: string; repo: RepoRef }[]> {
    if (!root) return [];
    const out: { remote: string; repo: RepoRef }[] = [];
    for (const r of await getRemotes(root)) {
      const repo = parseRemoteUrl(r.url, host);
      if (repo && !out.some((o) => o.repo.owner === repo.owner && o.repo.repo === repo.repo)) out.push({ remote: r.name, repo });
    }
    // Prefer "upstream" (fork workflow: PRs live there), then "origin".
    const rank = (n: string) => (n === 'upstream' ? 0 : n === 'origin' ? 1 : 2);
    return out.sort((a, b) => rank(a.remote) - rank(b.remote));
  }

  private async choosePr(
    gh: GitHubClient,
    host: string,
    repos: { remote: string; repo: RepoRef }[],
  ): Promise<{ repo: RepoRef; number: number } | undefined> {
    let repo: RepoRef | undefined;
    if (repos.length > 1) {
      const p = await vscode.window.showQuickPick(
        repos.map((r) => ({ label: `${r.repo.owner}/${r.repo.repo}`, description: r.remote, repo: r.repo })),
        { title: 'Review a pull request from which repository?' },
      );
      if (!p) return undefined;
      repo = p.repo;
    } else repo = repos[0]?.repo;

    type Item = vscode.QuickPickItem & { pick?: { repo: RepoRef; number: number } };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = repo ? `Open pull requests in ${repo.owner}/${repo.repo}` : 'Review a GitHub pull request';
    qp.placeholder = repo ? 'Pick a PR, or type a PR number / URL' : 'Type a PR URL (https://github.com/owner/repo/pull/123) or owner/repo#123';
    qp.matchOnDescription = true;
    let prItems: Item[] = [];
    const typedItem = (v: string): Item[] => {
      const ref = parsePrReference(v, host, repo);
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
            pick: { repo: repo!, number: p.number },
          }));
          qp.items = [...typedItem(qp.value), ...prItems];
        })
        .catch((e) => {
          this.log.warn(`Could not list PRs: ${(e as Error).message}`);
          qp.placeholder = 'Could not list PRs — type a PR number or URL';
        })
        .finally(() => (qp.busy = false));
    }
    return new Promise((resolve) => {
      let result: { repo: RepoRef; number: number } | undefined;
      qp.onDidAccept(() => {
        result = qp.selectedItems[0]?.pick ?? parsePrReference(qp.value, host, repo);
        if (result) qp.hide();
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

  private async withReviewProgress<T>(
    title: string,
    fn: (signal: AbortSignal, report: (msg: string, inc?: number) => void) => Promise<T>,
  ): Promise<T | undefined> {
    if (this.running) {
      vscode.window.showWarningMessage('A review is already running.');
      return undefined;
    }
    this.running = true;
    this.updateStatus();
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        async (progress, token) => {
          const ac = new AbortController();
          token.onCancellationRequested(() => ac.abort());
          return fn(ac.signal, (message, increment) => progress.report({ message, increment }));
        },
      );
    } finally {
      this.running = false;
      this.updateStatus();
    }
  }

  async reviewLocal(stagedOnly: boolean): Promise<void> {
    const s = readSettings();
    const root = await this.pickRepoRoot(true);
    if (!root) return;
    const llm = await this.llmClient();
    if (!llm) return;
    const exclude = makeExcluder(s.excludeGlobs);
    const what = stagedOnly ? 'staged changes' : 'uncommitted changes';
    this.log.info(`=== Reviewing ${what} in ${root}`);

    const result = await this.withReviewProgress(`Local Code Review: ${what}`, async (signal, report) => {
      report('Collecting diff…');
      const diff = await getLocalDiff(root, {
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
      const repoInstructions = s.instructionsFile ? await readRepoFile(root, s.instructionsFile) : undefined;
      if (repoInstructions) this.log.info(`Using review guidelines from ${s.instructionsFile}`);
      return runReview(diff.files, {
        llm,
        maxChunkChars: s.maxChunkChars,
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
    if (!result) return;

    const meta: ReportMeta = {
      title: `Review of ${what} — ${path.basename(root)}`,
      source: `${stagedOnly ? 'Staged' : 'Uncommitted'} changes in \`${root}\``,
      repoRoot: root,
    };
    this.setDiagnostics(result, root);
    await this.finish(result, meta);
  }

  async reviewPullRequest(arg?: unknown): Promise<void> {
    const s = readSettings();
    const host = webHostFromApiUrl(s.github.apiUrl);
    const root = await this.pickRepoRoot(false);
    const repos = await this.githubReposFor(root, host);
    const token = await this.githubToken(s);
    const gh = new GitHubClient(s.github.apiUrl, token, this.logger);

    const ref =
      typeof arg === 'string' || typeof arg === 'number'
        ? parsePrReference(String(arg), host, repos[0]?.repo)
        : await this.choosePr(gh, host, repos);
    if (!ref) return;
    const llm = await this.llmClient();
    if (!llm) return;
    const exclude = makeExcluder(s.excludeGlobs);
    const label = `${ref.repo.owner}/${ref.repo.repo}#${ref.number}`;
    this.log.info(`=== Reviewing ${label}`);

    const out = await this.withReviewProgress(`Local Code Review: ${label}`, async (signal, report) => {
      report('Fetching pull request…');
      const pr = await gh.getPull(ref.repo, ref.number);
      const { files, skipped } = await gh.getPullFiles(ref.repo, ref.number);
      let repoInstructions: string | undefined;
      if (s.instructionsFile) {
        repoInstructions = await gh.getFileContent(ref.repo, s.instructionsFile, pr.baseSha).catch(() => undefined);
        if (repoInstructions) {
          this.log.info(`Using review guidelines from ${s.instructionsFile}@${pr.baseRef}`);
          if (repoInstructions.length > 8000) repoInstructions = repoInstructions.slice(0, 8000) + '\n…[truncated]';
        }
      }
      const result = await runReview(files, {
        llm,
        maxChunkChars: s.maxChunkChars,
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
    if (!out) return;
    const { pr, result } = out;

    // Show findings in the Problems panel only if the PR head is what's checked out locally.
    const localMatches =
      !!root &&
      repos.some((r) => r.repo.owner === ref.repo.owner && r.repo.repo === ref.repo.repo) &&
      (await getHeadSha(root)) === pr.headSha;
    if (localMatches) this.setDiagnostics(result, root!);
    else this.diagnostics.clear();

    const meta: ReportMeta = {
      title: `Review of ${label}: ${pr.title}`,
      source: `[${label}](${pr.htmlUrl}) by @${pr.author} (${pr.headRef} → ${pr.baseRef})`,
      repoRoot: localMatches ? root : undefined,
      blobBaseUrl: `https://${host}/${ref.repo.owner}/${ref.repo.repo}/blob/${pr.headSha}`,
    };
    await this.finish(result, meta, { repo: ref.repo, info: pr, apiUrl: s.github.apiUrl });

    if (s.github.postReview === 'always') {
      await this.post(s.github.reviewEvent);
    } else if (s.github.postReview === 'ask') {
      const inline = result.findings.filter((f) => f.inline).length;
      const choice = await vscode.window.showInformationMessage(
        `Review of ${label} done: ${result.findings.length} finding(s), ${inline} on changed lines. Post it to GitHub?`,
        'Post review',
        'Post as draft (pending)',
        'Not now',
      );
      if (choice === 'Post review') await this.post(s.github.reviewEvent === 'PENDING' ? 'COMMENT' : s.github.reviewEvent);
      else if (choice === 'Post as draft (pending)') await this.post('PENDING');
    }
  }

  async postLast(): Promise<void> {
    if (!this.last?.pr) {
      vscode.window.showWarningMessage('Run "Review GitHub Pull Request" first.');
      return;
    }
    const s = readSettings();
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Comment', event: 'COMMENT' as ReviewEventSetting },
        { label: 'Request changes if there are critical/major findings', event: 'REQUEST_CHANGES_IF_BLOCKING' as ReviewEventSetting },
        { label: 'Pending (draft) review — edit and submit it on GitHub', event: 'PENDING' as ReviewEventSetting },
      ].map((o) => ({ ...o, description: o.event === s.github.reviewEvent ? 'default' : undefined })),
      { title: `Post review to ${this.last.pr.repo.owner}/${this.last.pr.repo.repo}#${this.last.pr.info.number}` },
    );
    if (choice) await this.post(choice.event);
  }

  private async post(event: ReviewEventSetting): Promise<void> {
    const last = this.last;
    if (!last?.pr) return;
    const s = readSettings();
    const gh = new GitHubClient(last.pr.apiUrl, await this.githubToken(s), this.logger);
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Posting review to GitHub…' },
      () => postReview(gh, last.pr!.repo, last.pr!.info, last.result, { event, suggestionBlocks: s.github.suggestionBlocks }, this.logger),
    );
    for (const n of r.notes) this.log.warn(n);
    this.log.info(`Posted review: ${r.url}`);
    last.meta.postedUrl = r.url;
    await vscode.workspace.fs.writeFile(last.reportUri, Buffer.from(renderMarkdownReport(last.result, last.meta), 'utf8'));
    const msg = `${event === 'PENDING' ? 'Pending review created' : 'Review posted'} with ${r.inlineCount} inline comment(s).${r.notes.length ? ' ' + r.notes.join(' ') : ''}`;
    const open = await vscode.window.showInformationMessage(msg, 'Open on GitHub');
    if (open) vscode.env.openExternal(vscode.Uri.parse(r.url));
  }

  private async finish(result: ReviewResult, meta: ReportMeta, pr?: LastReview['pr']): Promise<void> {
    this.log.info(
      `Done in ${(result.durationMs / 1000).toFixed(1)}s: ${result.findings.length} finding(s), ${result.errors.length} error(s)`,
    );
    const dir = vscode.Uri.joinPath(this.ctx.globalStorageUri, 'reports');
    await vscode.workspace.fs.createDirectory(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = meta.title.replace(/[^\w-]+/g, '-').replace(/-+/g, '-').slice(0, 60);
    const reportUri = vscode.Uri.joinPath(dir, `${stamp}-${slug}.md`);
    await vscode.workspace.fs.writeFile(reportUri, Buffer.from(renderMarkdownReport(result, meta), 'utf8'));
    this.last = { result, meta, reportUri, pr };
    await vscode.commands.executeCommand('setContext', 'localCodeReview.hasReview', true);
    await vscode.commands.executeCommand('setContext', 'localCodeReview.hasPrReview', !!pr);
    await this.openReport();
    if (result.errors.length) {
      vscode.window
        .showWarningMessage(`${result.errors.length} part(s) of the diff failed to review.`, 'Show Log')
        .then((c) => c && this.log.show());
    }
  }

  async openReport(): Promise<void> {
    if (!this.last) return;
    await vscode.commands.executeCommand('markdown.showPreview', this.last.reportUri);
  }

  private setDiagnostics(result: ReviewResult, root: string): void {
    this.diagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const sev: Record<Severity, vscode.DiagnosticSeverity> = {
      critical: vscode.DiagnosticSeverity.Error,
      major: vscode.DiagnosticSeverity.Warning,
      minor: vscode.DiagnosticSeverity.Information,
      nit: vscode.DiagnosticSeverity.Hint,
    };
    for (const f of result.findings) {
      if (f.file.startsWith('(')) continue;
      const start = Math.max(0, (f.line ?? 1) - 1);
      const end = Math.max(start, (f.endLine ?? f.line ?? 1) - 1);
      const d = new vscode.Diagnostic(
        new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER),
        `[${f.severity}] ${f.title}${f.body && f.body !== f.title ? `\n\n${f.body}` : ''}${f.suggestion ? `\n\nSuggested change:\n${f.suggestion}` : ''}`,
        sev[f.severity],
      );
      d.source = 'Local Code Review';
      if (f.category) d.code = f.category;
      const abs = path.join(root, f.file);
      if (!byFile.has(abs)) byFile.set(abs, []);
      byFile.get(abs)!.push(d);
    }
    for (const [file, diags] of byFile) this.diagnostics.set(vscode.Uri.file(file), diags);
  }

  clear(): void {
    this.diagnostics.clear();
  }

  async menu(): Promise<void> {
    const items: (vscode.QuickPickItem & { cmd: string })[] = [
      { label: '$(checklist) Review uncommitted changes', cmd: 'localCodeReview.reviewUncommitted' },
      { label: '$(diff-added) Review staged changes', cmd: 'localCodeReview.reviewStaged' },
      { label: '$(git-pull-request) Review a GitHub pull request…', cmd: 'localCodeReview.reviewPullRequest' },
    ];
    if (this.last) items.push({ label: '$(preview) Open last report', cmd: 'localCodeReview.openLastReport' });
    if (this.last?.pr) items.push({ label: '$(comment-discussion) Post last review to GitHub', cmd: 'localCodeReview.postLastReview' });
    items.push(
      { label: '$(clear-all) Clear findings', cmd: 'localCodeReview.clearFindings' },
      { label: '$(server) Select model', cmd: 'localCodeReview.selectModel', description: readSettings().llm.model },
      { label: '$(plug) Test LLM connection', cmd: 'localCodeReview.testConnection' },
      { label: '$(gear) Settings', cmd: 'localCodeReview.openSettings' },
    );
    const p = await vscode.window.showQuickPick(items, { title: 'Local Code Review' });
    if (p) await vscode.commands.executeCommand(p.cmd);
  }

  /** Wrap a command so errors surface as notifications with a "Show Log" button. */
  wrap(fn: (...args: any[]) => Promise<void> | void): (...args: any[]) => Promise<void> {
    return async (...args: any[]) => {
      try {
        await fn(...args);
      } catch (e) {
        if (e instanceof CancelledError || (e as Error).message === 'Cancelled') {
          vscode.window.showInformationMessage('Review cancelled.');
          return;
        }
        const msg = (e as Error).message ?? String(e);
        this.log.error(msg);
        const c = await vscode.window.showErrorMessage(`Local Code Review: ${msg}`, 'Show Log', 'Settings');
        if (c === 'Show Log') this.log.show();
        else if (c === 'Settings') vscode.commands.executeCommand('localCodeReview.openSettings');
      }
    };
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const c = new Controller(context);
  const reg = (id: string, fn: (...args: any[]) => Promise<void> | void) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, c.wrap(fn)));

  reg('localCodeReview.reviewUncommitted', () => c.reviewLocal(false));
  reg('localCodeReview.reviewStaged', () => c.reviewLocal(true));
  reg('localCodeReview.reviewPullRequest', (arg?: unknown) => c.reviewPullRequest(arg));
  reg('localCodeReview.postLastReview', () => c.postLast());
  reg('localCodeReview.openLastReport', () => c.openReport());
  reg('localCodeReview.selectModel', () => c.selectModel());
  reg('localCodeReview.testConnection', () => c.testConnection());
  reg('localCodeReview.setApiKey', () => c.setApiKey());
  reg('localCodeReview.clearFindings', () => c.clear());
  reg('localCodeReview.showMenu', () => c.menu());
  reg('localCodeReview.openSettings', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.local-code-review');
  });
}

export function deactivate(): void {}
