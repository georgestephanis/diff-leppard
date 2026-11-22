#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${INPUT_PR_NUMBER:-}" ]]; then
  echo "::error::No pull request number. Run on pull_request / issue_comment events or set the pr-number input."
  exit 2
fi
# An input reaches the CLI only when it's set, so an empty one leaves the repo's .diff-leppard.json and any
# DIFF_LEPPARD_* variable from the step's env in effect.
from_input() {
  if [[ -n "${!1:-}" ]]; then export "$2=${!1}"; fi
}
from_input INPUT_GITHUB_API_URL DIFF_LEPPARD_GITHUB_API_URL
from_input INPUT_BASE_URL DIFF_LEPPARD_BASE_URL
from_input INPUT_MODEL DIFF_LEPPARD_MODEL
from_input INPUT_API_KEY DIFF_LEPPARD_API_KEY
from_input INPUT_PROVIDER DIFF_LEPPARD_PROVIDER
from_input INPUT_EXTRA_HEADERS DIFF_LEPPARD_EXTRA_HEADERS
from_input INPUT_EXTRA_BODY DIFF_LEPPARD_EXTRA_BODY
from_input INPUT_JSON_MODE DIFF_LEPPARD_JSON_MODE
from_input INPUT_MIN_SEVERITY DIFF_LEPPARD_MINIMUM_SEVERITY
from_input INPUT_MAX_CHUNK_CHARS DIFF_LEPPARD_MAX_CHUNK_CHARS
from_input INPUT_MAX_OUTPUT_TOKENS DIFF_LEPPARD_MAX_OUTPUT_TOKENS
from_input INPUT_CONCURRENCY DIFF_LEPPARD_CONCURRENCY
from_input INPUT_TIMEOUT_SECONDS DIFF_LEPPARD_REQUEST_TIMEOUT_SECONDS
from_input INPUT_EXTRA_INSTRUCTIONS DIFF_LEPPARD_EXTRA_INSTRUCTIONS
from_input INPUT_ATTRIBUTION DIFF_LEPPARD_GITHUB_ATTRIBUTION
from_input INPUT_VERIFY_FINDINGS DIFF_LEPPARD_VERIFY_FINDINGS
from_input INPUT_CHECK_DESCRIPTION DIFF_LEPPARD_CHECK_DESCRIPTION
unset INPUT_API_KEY INPUT_EXTRA_HEADERS

# Keep the server address and credentials out of (possibly public) logs, even if passed as plain variables.
[[ -n "${DIFF_LEPPARD_API_KEY:-}" ]] && echo "::add-mask::$DIFF_LEPPARD_API_KEY"
[[ -n "${DIFF_LEPPARD_BASE_URL:-}" ]] && echo "::add-mask::$DIFF_LEPPARD_BASE_URL"
if [[ -n "${DIFF_LEPPARD_EXTRA_HEADERS:-}" ]]; then
  node -e 'for (const v of Object.values(JSON.parse(process.argv[1]))) console.log(`::add-mask::${v}`)' "$DIFF_LEPPARD_EXTRA_HEADERS"
fi

args=(pr "$INPUT_PR_NUMBER" --repo "$INPUT_REPOSITORY" --no-prompt --format markdown --output "$RUNNER_TEMP/diff-leppard.json" --output "$RUNNER_TEMP/diff-leppard.sarif")
case "${INPUT_REVIEW_EVENT:-comment}" in
  comment) args+=(--post) ;;
  request-changes) args+=(--request-changes) ;;
  none | "") ;;
  *) echo "::error::review-event must be comment, request-changes or none"; exit 2 ;;
esac
[[ -n "${INPUT_FAIL_ON:-}" ]] && args+=(--fail-on "$INPUT_FAIL_ON")
case "${INPUT_NO_CONTEXT:-}" in
  true) args+=(--no-context) ;;
  false | "") ;;
  *) echo "::error::no-context must be true or false"; exit 2 ;;
esac

report="$RUNNER_TEMP/diff-leppard.md"
set +e
node "$GITHUB_ACTION_PATH/dist/cli.js" "${args[@]}" >"$report"
code=$?
set -e

if [[ -s "$report" ]]; then
  cat "$report" >>"$GITHUB_STEP_SUMMARY"
fi
if [[ -f "$RUNNER_TEMP/diff-leppard.json" ]]; then
  node -e '
    const r = require(process.argv[1]);
    const blocking = r.findings.filter((f) => f.severity === "critical" || f.severity === "major").length;
    require("fs").appendFileSync(process.env.GITHUB_OUTPUT, `findings=${r.findings.length}\nblocking=${blocking}\n`);
    for (const f of r.findings) {
      const lvl = f.severity === "critical" || f.severity === "major" ? "warning" : "notice";
      // Workflow-command escaping: data needs % CR LF; properties additionally need : and ,
      const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
      const prop = (s) => esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
      console.log(`::${lvl} title=${prop(`[${f.severity}] ${f.title}`)}::${esc(`${f.file}${f.line ? ":" + f.line : ""} ${f.body}`)}`);
    }
  ' "$RUNNER_TEMP/diff-leppard.json"
fi
echo "report=$report" >>"$GITHUB_OUTPUT"
[[ -f "$RUNNER_TEMP/diff-leppard.sarif" ]] && echo "sarif=$RUNNER_TEMP/diff-leppard.sarif" >>"$GITHUB_OUTPUT"
if [[ $code -eq 1 ]]; then
  echo "::error::Findings at or above '${INPUT_FAIL_ON}' severity."
fi
exit $code
