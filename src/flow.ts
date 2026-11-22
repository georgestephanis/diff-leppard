/** End-to-end review flows shared by the CLI's `pr` and `watch` commands (no `vscode` imports). */
import { CliSettings, LoadedConfig, parseJsonc, REPO_CONFIG_FILE, RepoConfigInput, userConfigPath } from './config';
import * as path from 'path';
import { attachFileContents, findRelatedCode, githubRepoView, gitRepoView, INDEX, loadGuidelines, localViewAt, planBudget, RepoView } from './context';
import { makeExcluder } from './diff';
import { ghExec, githubRemotes } from './gh';
import { getLocalDiff, git, isNullSha, resolveRef } from './git';
import { GitHubClient, PullRequestInfo, RepoRef } from './github';
import { LlmClient, LlmConfig, resolveChunkChars } from './llm';
import { loadPullRequest } from './pr';
import { renderMarkdownReport } from './report';
import { ReviewOptions, runReview } from './review';
import { FileDiff } from './types';
import { Logger, ReviewResult } from './types';

export function llmBase(s: CliSettings): Omit<LlmConfig, 'model'> {
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
export async function makeLlm(s: CliSettings, log: Logger): Promise<LlmClient> {
  const cfg = { ...llmBase(s), model: s.model };
  if (!cfg.model) {
    const models = await new LlmClient(cfg, log).listModels();
    if (models.length !== 1) {
      throw new Error(
        models.length
          ? `No model configured and the server has ${models.length}: ${models.join(', ')}. Pass --model or set "model" in ${userConfigPath()}.`
          : `The server at ${cfg.baseUrl} reported no models.`,
      );
    }
    cfg.model = models[0];
    log.info(`Using the server's only model: ${cfg.model}`);
  }
  return new LlmClient(cfg, log);
}

export interface PrReview {
  pr: PullRequestInfo;
  result: ReviewResult;
  /** Settings after applying the repo's base-branch config. */
  settings: CliSettings;
  title: string;
  markdown: () => string;
}

/**
 * Review one pull request: apply the repo config from the PR's *base* branch (a PR can't change how it is
 * itself reviewed), load the diff and guidelines, size chunks to the model, and run the review.
 */
export async function reviewPullRequest(p: {
  client: GitHubClient;
  repo: RepoRef;
  number: number;
  host: string;
  settings: CliSettings;
  /** Reload settings with a repo config layered in (user < repo < env < flags). */
  configure: (repo: RepoConfigInput | undefined) => Promise<LoadedConfig>;
  log: Logger;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Already-fetched PR metadata. */
  prefetched?: PullRequestInfo;
  /** A local clone of the repo, if any: used to search for related code when it has the PR's head commit. */
  localRoot?: string;
}): Promise<PrReview> {
  const label = `${p.repo.owner}/${p.repo.repo}#${p.number}`;
  let s = p.settings;
  const pr0 = p.prefetched ?? (await p.client.getPull(p.repo, p.number));
  const repoCfgText = await p.client.getFileContent(p.repo, REPO_CONFIG_FILE, pr0.baseSha).catch(() => undefined);
  if (repoCfgText !== undefined) {
    let json: unknown;
    try {
      json = parseJsonc(repoCfgText);
    } catch (e) {
      throw new Error(`Could not parse ${REPO_CONFIG_FILE} on ${pr0.baseRef} of ${label}: ${(e as Error).message}`);
    }
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const source = `${p.repo.owner}/${p.repo.repo}@${pr0.baseRef}:${REPO_CONFIG_FILE}`;
      const loaded = await p.configure({ json: json as Record<string, unknown>, source });
      s = loaded.settings;
      p.log.info(`config: ${source}`);
      for (const w of loaded.warnings) p.log.warn(w);
    }
  }
  // Guidelines come from prepareContext (base branch, with the AGENTS.md fallback), not loadPullRequest.
  const loaded = await loadPullRequest(p.client, p.repo, p.number, undefined, p.log, pr0);
  const llm = await makeLlm(s, p.log);
  // A local checkout that has the PR's head commit allows searching the repo; otherwise read through the API.
  const local = await localViewAt(p.localRoot, loaded.pr.headSha);
  const ctx = await prepareContext({
    files: loaded.files,
    settings: s,
    llm,
    view: local ?? (loaded.pr.headSha ? githubRepoView(p.client, p.repo, loaded.pr.headSha) : undefined),
    guideView: (await localViewAt(p.localRoot, loaded.pr.baseSha)) ?? (loaded.pr.baseSha ? githubRepoView(p.client, p.repo, loaded.pr.baseSha) : undefined),
    log: p.log,
    signal: p.signal,
  });
  if (s.agentic && !local) p.log.warn('Agentic mode needs a local clone that has the PR head commit (run from a checkout and fetch it); reviewing without tools.');
  const result = await runReview(loaded.files, {
    llm,
    ...ctx,
    concurrency: s.concurrency,
    minimumSeverity: s.minimumSeverity,
    exclude: makeExcluder(s.excludeGlobs),
    verify: s.verifyFindings,
    agent: s.agentic && local ? { view: local, before: await localViewAt(p.localRoot, loaded.pr.baseSha), maxToolCalls: s.maxToolCalls, exclude: makeExcluder(s.excludeGlobs) } : undefined,
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
  const markdown = () =>
    renderMarkdownReport(result, {
      title,
      source: `[${label}](${pr.htmlUrl}) by @${pr.author} (${pr.headRef} → ${pr.baseRef})`,
      blobBaseUrl: `https://${p.host}/${p.repo.owner}/${p.repo.repo}/blob/${pr.headSha}`,
    });
  return { pr, result, settings: s, title, markdown };
}

/**
 * Size one request from the model's context window and gather the extra context that fits: the changed files
 * (whole, or with widened hunks), related code from elsewhere in the repo, and the review guidelines.
 * `view` is the repo at the reviewed (new) revision; `guideView` where guidelines are read from (for a PR, its base).
 */
export type ContextSettingsInput = Pick<
  CliSettings,
  'maxChunkChars' | 'maxOutputTokens' | 'instructionsFile' | 'instructionsFallback' | 'maxInstructionsChars' | 'fullFileMaxChars' | 'relatedMaxChars' | 'excludeGlobs'
>;

export async function prepareContext(p: {
  files: FileDiff[];
  settings: ContextSettingsInput;
  llm: LlmClient;
  view?: RepoView;
  guideView?: RepoView;
  log: Logger;
  signal?: AbortSignal;
}): Promise<Pick<ReviewOptions, 'maxChunkChars' | 'contextChars' | 'related' | 'relatedChars' | 'contextNotes' | 'view'> & { repoInstructions?: string }> {
  const s = p.settings;
  const total = await resolveChunkChars(p.llm, s.maxChunkChars, s.maxOutputTokens, p.log, p.signal);
  const plan = planBudget(total, s);
  const notes: string[] = [];
  let repoInstructions: string | undefined;
  if (p.guideView && plan.instructions > 0) {
    const g = await loadGuidelines(p.guideView, s.instructionsFile, s.instructionsFallback, plan.instructions, p.log);
    if (g) {
      repoInstructions = g.text;
      notes.push(`guidelines: ${g.source} (${g.text.length} chars)`);
    }
  }
  const used = (repoInstructions?.length ?? 0) + (s.relatedMaxChars > 0 && p.view?.grep ? plan.related : 0);
  const maxChunkChars = Math.max(Math.min(2000, total), total - used);
  const contextChars = Math.min(plan.fullFile, Math.floor(maxChunkChars * 0.8));
  if (p.view && contextChars > 0) {
    await attachFileContents(p.files, p.view, contextChars, p.log, makeExcluder(s.excludeGlobs));
    const loaded = p.files.filter((f) => f.content).length;
    if (loaded) notes.push(`surrounding code: up to ${contextChars} chars per file, ${loaded} file(s) loaded`);
  }
  let related: ReviewOptions['related'];
  if (p.view && s.relatedMaxChars > 0 && plan.related > 0) {
    if (!p.view.grep) p.log.info(`context: related-code search needs a local checkout of the reviewed commit; skipped (${p.view.describe})`);
    else {
      related = await findRelatedCode(p.files, p.view, { exclude: makeExcluder(s.excludeGlobs), log: p.log });
      for (const [f, sn] of related) notes.push(`related to ${f}: ${sn.map((x) => `${x.path} (${x.reason})`).join('; ')}`);
    }
  }
  p.log.info(`Request budget ${total} chars: diff ${maxChunkChars}, guidelines ${repoInstructions?.length ?? 0}, related up to ${s.relatedMaxChars ? plan.related : 0}+`);
  return { maxChunkChars, contextChars, related, relatedChars: { reserve: plan.related, max: s.relatedMaxChars }, contextNotes: notes, repoInstructions, view: p.view };
}

/** Commit messages of a range as a change title + description (at most 20 commits / 4000 chars). */
export async function commitMessages(root: string, range: string): Promise<{ title?: string; description: string } | undefined> {
  if (!range || range.startsWith('-')) return undefined;
  const out = await git(root, ['log', '--no-merges', '-n', '20', '--format=%s%x1f%b%x1e', range, '--'], true);
  const commits = out
    .split('\x1e')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [subject, body = ''] = c.split('\x1f');
      return { subject: subject.trim(), body: body.trim() };
    });
  if (!commits.length) return undefined;
  if (commits.length === 1) return { title: commits[0].subject, description: commits[0].body.slice(0, 4000) };
  return { description: commits.map((c) => `- ${c.subject}${c.body ? `\n  ${c.body.replace(/\n/g, '\n  ')}` : ''}`).join('\n').slice(0, 4000) };
}

/** A problem with what was asked for (bad ref, not a repo, …), as opposed to a failure while reviewing. */
export class ReviewInputError extends Error {}

/** The GitHub repo for a checkout: what `gh` thinks, else the first GitHub remote (upstream, then origin). */
export async function defaultRepo(cwd: string, root: string | undefined, host: string): Promise<RepoRef | undefined> {
  try {
    const nwo = await ghExec(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd);
    const m = /^([^/]+)\/([^/]+)$/.exec(nwo);
    if (m) return { owner: m[1], repo: m[2] };
  } catch {
    /* no gh, or not a GitHub repo for gh */
  }
  return (await githubRemotes(root, host))[0]?.repo;
}

export interface LocalReviewRequest {
  /** Repo root. */
  root: string;
  settings: CliSettings;
  /** At most one of these. Neither: uncommitted changes (including untracked files). */
  staged?: boolean;
  /** Everything since the merge-base with this ref (committed + uncommitted). */
  base?: string;
  /** Exactly these commits: `a..b`, or `a...b` for "since their merge-base". */
  range?: string;
  /** Title and description of the change; for --range and --base the commit messages are used when not given. */
  title?: string;
  description?: string;
  log: Logger;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface LocalReview {
  /** "uncommitted changes", "changes since main", … */
  what: string;
  /** Undefined when there was nothing to review. */
  result?: ReviewResult;
  title: string;
  markdown: () => string;
}

/** Review local changes in a repo (shared by `diff-leppard local` and the MCP server). */
export async function reviewLocalChanges(p: LocalReviewRequest): Promise<LocalReview> {
  const s = p.settings;
  if ([p.staged, p.base, p.range].filter(Boolean).length > 1) throw new ReviewInputError('Use only one of staged, base and range');
  let range: { from: string; to: string } | undefined;
  if (p.range) {
    const m = /^(.+?)(\.{2,3})(.+)$/.exec(p.range);
    if (!m) throw new ReviewInputError('range must look like <from>..<to> (or <from>...<to> for "since the merge-base")');
    range = { from: m[1], to: m[3] };
    if (m[2] === '...') {
      let mb = '';
      try {
        mb = (await git(p.root, ['merge-base', await resolveRef(p.root, m[1]), await resolveRef(p.root, m[3])])).trim();
      } catch (e) {
        throw new ReviewInputError((e as Error).message);
      }
      if (!mb) throw new ReviewInputError(`No common ancestor between ${m[1]} and ${m[3]}`);
      range.from = mb;
    }
  }
  const what = p.range ? `commits ${p.range}` : p.base ? `changes since ${p.base}` : p.staged ? 'staged changes' : 'uncommitted changes';
  const name = path.basename(p.root);
  const title = `Review of ${what} — ${name}`;
  p.onProgress?.('Collecting diff…');
  const exclude = makeExcluder(s.excludeGlobs);
  let diff;
  try {
    diff = await getLocalDiff(p.root, {
      stagedOnly: !!p.staged,
      base: p.base,
      range,
      contextLines: s.contextLines,
      includeUntracked: s.includeUntracked,
      maxUntrackedBytes: 256 * 1024,
      exclude,
    });
  } catch (e) {
    throw new ReviewInputError((e as Error).message);
  }
  if (!diff.files.length) return { what, title, markdown: () => `No ${what} in ${name}.\n` };
  const llm = await makeLlm(s, p.log);
  // The reviewed revision: the range's end commit, else the working tree. Guidelines come from the range's
  // start (like a PR's base), else the working tree.
  const toSha = range ? await resolveRef(p.root, range.to) : undefined;
  const fromSha = range && !isNullSha(range.from) ? await resolveRef(p.root, range.from).catch(() => undefined) : undefined;
  // What the reviewed code is read from (staged reviews: the index, not the working tree), and what it changed from.
  const reviewed = gitRepoView(p.root, toSha ?? (p.staged ? INDEX : undefined));
  let beforeRev = fromSha;
  if (!range) {
    beforeRev = p.base
      ? (await git(p.root, ['merge-base', await resolveRef(p.root, p.base), 'HEAD'], true)).trim() || undefined
      : (await git(p.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], true)).trim() || undefined;
  }
  const before = beforeRev ? gitRepoView(p.root, beforeRev) : undefined;
  const ctx = await prepareContext({
    files: diff.files,
    settings: s,
    llm,
    view: reviewed,
    guideView: range ? gitRepoView(p.root, fromSha ?? toSha) : reviewed,
    log: p.log,
    signal: p.signal,
  });
  let changeTitle = p.title;
  let changeDescription = p.description;
  if (changeDescription === undefined && (range || p.base)) {
    const msgs = await commitMessages(p.root, range ? (fromSha ? `${fromSha}..${toSha}` : toSha!) : `${p.base}..HEAD`);
    if (msgs) {
      changeTitle ??= msgs.title;
      changeDescription = msgs.description;
    }
  }
  const result = await runReview(diff.files, {
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
    markdown: () => renderMarkdownReport(result, { title, source: `${what[0].toUpperCase()}${what.slice(1)} in **${name}**` }),
  };
}
