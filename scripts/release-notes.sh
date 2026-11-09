#!/usr/bin/env bash
# Print the CHANGELOG.md section for a version (used for GitHub release notes).
#   scripts/release-notes.sh 1.2.0
set -euo pipefail
version="${1:?usage: release-notes.sh <version>}"
notes="$(awk -v v="$version" '
  $0 ~ "^## " v "( |$)" { found = 1; next }
  found && /^## / { exit }
  found { print }
' "$(dirname "$0")/../CHANGELOG.md")"
if [[ -z "${notes//[[:space:]]/}" ]]; then
  echo "No CHANGELOG.md section for $version" >&2
  exit 1
fi
printf '%s\n\n' "$notes"
cat <<MD
### Install
- **VS Code / Cursor / VSCodium:** download \`diff-leppard.vsix\` below, then run \`code --install-extension diff-leppard.vsix\`
- **CLI:** \`npm install -g https://github.com/georgestephanis/diff-leppard/releases/download/v$version/diff-leppard.tgz\`
- **GitHub Action:** \`uses: georgestephanis/diff-leppard@v${version%%.*}\`
- **Claude Code:** \`/plugin install diff-leppard --marketplace georgestephanis/diff-leppard\`
MD
