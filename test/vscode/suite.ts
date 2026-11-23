import assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';
import * as vscode from 'vscode';

const REVIEW = {
  summary: 'Adds a query helper with an injection bug.',
  findings: [
    { file: 'users.js', line: 6, severity: 'critical', category: 'security', title: 'SQL injection', body: 'Use a parameterized query.' },
    { file: 'new.js', line: 1, severity: 'nit', title: 'Tiny nit', body: 'Below minimumSeverity, should be dropped.' },
  ],
};

export async function run(): Promise<void> {
  const prompts: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      prompts.push(JSON.parse(body).messages[1].content);
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(REVIEW) }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  try {
    const cfg = vscode.workspace.getConfiguration('diffLeppard');
    await cfg.update('baseUrl', url, vscode.ConfigurationTarget.Global);
    await cfg.update('model', '', vscode.ConfigurationTarget.Global); // exercise "only one model" auto-pick

    const ext = vscode.extensions.getExtension('georgestephanis.diff-leppard');
    assert.ok(ext, 'extension found');
    await ext.activate();
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['reviewUncommitted', 'reviewStaged', 'reviewPullRequest', 'postLastReview', 'selectModel', 'testConnection']) {
      assert.ok(cmds.includes(`diffLeppard.${c}`), `command ${c} registered`);
    }

    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    await Promise.race([
      vscode.commands.executeCommand('diffLeppard.reviewUncommitted'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('review timed out')), 60000)),
    ]);

    // First request is the review; the critical finding then gets a verification request (verifyFindings).
    assert.equal(prompts.length, 2, 'one review request and one verification request (the nit is not verified)');
    const [prompt, verifyPrompt] = prompts;
    assert.match(prompt, /=== File: users\.js \(modified, whole file\) ===/);
    assert.match(prompt, /=== File: new\.js \(added\) ===/, 'untracked file included');
    assert.match(verifyPrompt ?? '', /SQL injection/, 'critical finding sent for verification');
    const diags = vscode.languages.getDiagnostics(vscode.Uri.file(path.join(root, 'users.js')));
    assert.equal(diags.length, 1, `diagnostics on users.js: ${JSON.stringify(diags)}`);
    assert.equal(diags[0].severity, vscode.DiagnosticSeverity.Error);
    assert.equal(diags[0].range.start.line, 5);
    assert.match(diags[0].message, /SQL injection/);
    assert.equal(vscode.languages.getDiagnostics(vscode.Uri.file(path.join(root, 'new.js'))).length, 0, 'nit filtered out');

    await vscode.commands.executeCommand('diffLeppard.clearFindings');
    assert.equal(vscode.languages.getDiagnostics(vscode.Uri.file(path.join(root, 'users.js'))).length, 0);

    // A repo's .diff-leppard.json applies on top of the user's settings, like in the CLI.
    fs.writeFileSync(path.join(root, '.diff-leppard.json'), JSON.stringify({ minimumSeverity: 'nit' }));
    await Promise.race([
      vscode.commands.executeCommand('diffLeppard.reviewUncommitted'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('review timed out')), 60000)),
    ]);
    assert.equal(vscode.languages.getDiagnostics(vscode.Uri.file(path.join(root, 'new.js'))).length, 1, "the repo config's minimumSeverity keeps the nit");
    fs.rmSync(path.join(root, '.diff-leppard.json'));
    await vscode.commands.executeCommand('diffLeppard.clearFindings');

    // The Source Control commit box's message tells a local review what the change is for.
    const gitApi = (await vscode.extensions.getExtension<any>('vscode.git')!.activate()).getAPI(1);
    let scmRepo: any;
    for (let i = 0; i < 100 && !(scmRepo = gitApi.repositories.find((r: any) => path.resolve(r.rootUri.fsPath) === path.resolve(fs.realpathSync(root)) || path.resolve(r.rootUri.fsPath) === path.resolve(root))); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(scmRepo, 'git extension found the test repo');
    scmRepo.inputBox.value = 'Add a user lookup helper\n\nUsed by the admin page.';
    prompts.length = 0;
    await Promise.race([
      vscode.commands.executeCommand('diffLeppard.reviewUncommitted'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('review timed out')), 60000)),
    ]);
    assert.match(prompts[0], /Change title: Add a user lookup helper/);
    assert.match(prompts[0], /Change description:\nUsed by the admin page\./);
    scmRepo.inputBox.value = '';
    await cfg.update('localDescription', 'off', vscode.ConfigurationTarget.Global);
    prompts.length = 0;
    scmRepo.inputBox.value = 'Should not be sent';
    await Promise.race([
      vscode.commands.executeCommand('diffLeppard.reviewUncommitted'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('review timed out')), 60000)),
    ]);
    assert.doesNotMatch(prompts[0], /Should not be sent/, 'localDescription: off ignores the commit box');
    scmRepo.inputBox.value = '';
    await vscode.commands.executeCommand('diffLeppard.clearFindings');
    console.log('VS Code integration test passed');
  } finally {
    server.close();
  }
}
