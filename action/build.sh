#!/usr/bin/env bash
# Compile just the CLI with TypeScript + @types/node (skips the VS Code extension's heavy dev dependencies).
set -euo pipefail
cd "$GITHUB_ACTION_PATH"
if [[ -f out/src/cli.js ]]; then exit 0; fi
tools="$RUNNER_TEMP/lcr-build"
mkdir -p "$tools"
npm install --prefix "$tools" --no-audit --no-fund --no-save --silent typescript@5.6 @types/node@20 >/dev/null
node "$tools/node_modules/typescript/bin/tsc" -p tsconfig.cli.json --typeRoots "$tools/node_modules/@types"
echo "Built $(node out/src/cli.js --version 2>/dev/null || echo CLI)"
