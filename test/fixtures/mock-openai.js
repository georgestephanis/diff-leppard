// Minimal OpenAI-compatible server for CI: flags the first added line of every file it is shown.
const http = require('http');
const port = Number(process.argv[2] || 8765);
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      const prompt = JSON.parse(body).messages.at(-1).content;
      const findings = [];
      let file;
      for (const line of prompt.split('\n')) {
        const f = /^=== File: (.+?) \(/.exec(line);
        if (f) file = f[1];
        const m = /^\s*(\d+) \+ /.exec(line);
        if (file && m && !findings.some((x) => x.file === file)) {
          findings.push({ file, line: Number(m[1]), severity: 'minor', category: 'testing', title: 'Mock finding', body: 'Emitted by the CI mock server.' });
        }
      }
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'Mock review.', findings }) }, finish_reason: 'stop' }] }));
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`mock OpenAI server on :${port}`));
