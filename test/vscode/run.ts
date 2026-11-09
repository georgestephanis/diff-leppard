/**
 * Integration test: launches VS Code with this extension against a throwaway git repo
 * and a mock OpenAI-compatible server. Run with `npm run test:vscode`.
 * Set VSCODE_PATH to use an installed VS Code instead of downloading one.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-leppard-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'users.js'), "function getUser(id) {\n  return id;\n}\n");
  git('add', '.');
  git('commit', '-qm', 'init');
  fs.writeFileSync(
    path.join(repo, 'users.js'),
    "function getUser(id) {\n  return id;\n}\n\nfunction findUsers(db, name) {\n  return db.query(\"SELECT * FROM users WHERE name = '\" + name + \"'\");\n}\n",
  );
  fs.writeFileSync(path.join(repo, 'new.js'), 'module.exports = 1;\n');

  await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH || undefined,
    extensionDevelopmentPath: path.resolve(__dirname, '../../..'),
    extensionTestsPath: path.resolve(__dirname, './suite'),
    launchArgs: [repo, '--disable-extensions', '--user-data-dir', path.join(tmp, 'user'), '--skip-welcome', '--skip-release-notes'],
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
