/**
 * Experimental agentic review: the model may call read-only tools (read a file, search the repo, list a
 * folder) before it answers. Tools only see the repository at the reviewed revision (RepoView), output is
 * size-capped, and the number of calls and total characters are budgeted from the model's context window.
 *
 * No `vscode` imports.
 */
import { RepoView, safeRepoPath } from './context';
import { globToRegExp } from './diff';
import { ChatMessage, LlmClient, ToolDef, ToolMessage } from './llm';
import { Logger } from './types';

export interface AgentOptions {
  /** The repo at the reviewed revision. */
  view: RepoView;
  /** The repo before the change (for "what did this look like before"), if known. */
  before?: RepoView;
  maxToolCalls: number;
  /** Most characters of tool output in one review request (from the context budget). */
  budgetChars: number;
  exclude: (p: string) => boolean;
}

const MAX_TOOL_OUTPUT = 6000;

export const AGENT_TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description: 'Read a file from the repository at the reviewed commit, with line numbers. Use start_line/end_line for part of a large file. Set before=true to read the version before the change.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repository-relative path' },
        start_line: { type: 'integer' },
        end_line: { type: 'integer' },
        before: { type: 'boolean' },
      },
      required: ['path'],
    },
  },
  {
    name: 'grep',
    description: 'Search the repository for an exact string (not a regex). Returns matching lines as path:line: text.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Exact text to find, e.g. a function, CSS class or config key' },
        path_glob: { type: 'string', description: 'Optional glob to limit the search, e.g. "**/*.css" or "scripts/**"' },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_dir',
    description: 'List the files under a directory at the reviewed commit, with the last commit that changed it.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

export function agentInstructions(maxCalls: number): string {
  return `You can use read-only tools to look at the repository before you answer: read_file, grep and list_dir. Use them to check what the diff alone doesn't show, for example other places that use a changed name, rules elsewhere in a stylesheet, the enclosing condition of a template line, a README that explains a data folder, or the test that pins a behaviour. Check a suspected problem before reporting it, and don't report one the code you read rules out. You have at most ${maxCalls} tool calls. When you are done, reply with the JSON object described above and no tool call.`;
}

function cap(s: string, n = MAX_TOOL_OUTPUT): string {
  return s.length <= n ? s : s.slice(0, n) + `\n…[cut at ${n} characters; ask for a smaller range]`;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function int(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Run one tool call. Never throws: errors come back as text the model can read. */
export async function runTool(name: string, args: Record<string, unknown>, o: AgentOptions): Promise<string> {
  try {
    if (name === 'read_file') {
      const p = str(args.path);
      if (!p || !safeRepoPath(p)) return 'error: path must be a repository-relative path';
      if (o.exclude(p)) return `error: ${p} is excluded from review`;
      const view = args.before === true ? o.before : o.view;
      if (!view) return 'error: the version before the change is not available';
      const text = await view.read(p);
      if (text === undefined) return `error: ${p} does not exist${args.before === true ? ' before the change' : ''}, or is binary or too large`;
      const lines = text.split('\n');
      const a = Math.max(1, int(args.start_line) ?? 1);
      const b = Math.min(lines.length, int(args.end_line) ?? a + 299);
      const w = String(b).length;
      const body = lines.slice(a - 1, b).map((l, i) => `${String(a + i).padStart(w)}  ${l}`).join('\n');
      return cap(`${p} lines ${a}-${b} of ${lines.length}:\n${body}`);
    }
    if (name === 'grep') {
      const t = str(args.text);
      if (!t || t.length < 2) return 'error: text is required (at least 2 characters)';
      if (!o.view.grep) return 'error: search is not available for this review';
      const glob = str(args.path_glob);
      const re = glob ? globToRegExp(glob) : undefined;
      const hits = (await o.view.grep([t], 400)).filter((h) => !o.exclude(h.path) && (!re || re.test(h.path)));
      if (!hits.length) return `no matches for "${t}"${glob ? ` in ${glob}` : ''}`;
      return cap(hits.slice(0, 60).map((h) => `${h.path}:${h.line}: ${h.text.trim().slice(0, 200)}`).join('\n') + (hits.length > 60 ? `\n… ${hits.length} matches in total` : ''));
    }
    if (name === 'list_dir') {
      const p = str(args.path)?.replace(/\/+$/, '');
      if (!p || !safeRepoPath(p)) return 'error: path must be a repository-relative directory';
      const files = await o.view.list?.(p, 2000);
      if (!files?.length) return `${p} is not a directory at this commit (or is empty)`;
      const last = await o.view.lastChange?.(p);
      const shown = files.slice(0, 80).join('\n');
      return cap(`${p}: ${files.length >= 2000 ? '2000+' : files.length} files${last ? `, last changed by commit ${last}` : ''}\n${shown}${files.length > 80 ? '\n…' : ''}`);
    }
    return `error: unknown tool ${name}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

/**
 * Run the review conversation with tools until the model answers or the budget runs out; then ask for the
 * answer without tools. Returns the final reply text (to be parsed like a normal review reply).
 */
export async function agenticReply(
  llm: LlmClient,
  messages: ChatMessage[],
  o: AgentOptions,
  log: Logger,
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: number; toolChars: number }> {
  const convo: ToolMessage[] = messages.map((m) => (m.role === 'system' ? { ...m, content: `${m.content}\n\n${agentInstructions(o.maxToolCalls)}` } : { ...m }));
  let calls = 0;
  let chars = 0;
  for (let turn = 0; turn < o.maxToolCalls + 2; turn++) {
    const res = await llm.chatTools(convo, AGENT_TOOLS, { signal });
    if (!res.toolCalls.length) return { content: res.content, toolCalls: calls, toolChars: chars };
    convo.push({ role: 'assistant', content: res.content ?? '', tool_calls: res.toolCalls });
    let exhausted = false;
    for (const c of res.toolCalls) {
      let out: string;
      if (calls >= o.maxToolCalls || chars >= o.budgetChars) {
        out = 'error: tool budget used up; answer now with what you have';
        exhausted = true;
      } else {
        out = await runTool(c.name, c.args, o);
        if (chars + out.length > o.budgetChars) out = cap(out, Math.max(200, o.budgetChars - chars));
        calls++;
        chars += out.length;
        log.info(`  tool ${c.name}(${JSON.stringify(c.args).slice(0, 120)}) → ${out.length} chars`);
      }
      convo.push({ role: 'tool', content: out, tool_call_id: c.id, name: c.name });
    }
    if (exhausted || calls >= o.maxToolCalls || chars >= o.budgetChars) break;
  }
  // Out of budget: one last request without tools.
  convo.push({ role: 'user', content: 'Stop using tools now. Reply with ONLY the JSON object described in the instructions.' });
  const flat: ChatMessage[] = convo.map((m) =>
    m.role === 'tool'
      ? { role: 'user', content: `Result of ${m.name}:\n${m.content}` }
      : m.role === 'assistant' && m.tool_calls?.length
        ? { role: 'assistant', content: `${m.content}\n(called ${m.tool_calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(', ')})`.trim() }
        : { role: m.role as ChatMessage['role'], content: m.content },
  );
  const last = await llm.chat(flat, { signal });
  return { content: last.content, toolCalls: calls, toolChars: chars };
}
