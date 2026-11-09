#!/usr/bin/env node
'use strict';
const { main } = require('../out/src/cli.js');
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`error: ${e && e.message ? e.message : e}\n`);
    process.exit(2);
  },
);
