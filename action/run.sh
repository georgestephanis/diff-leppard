#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${INPUT_PR_NUMBER:-}" ]]; then
  echo "::error::No pull request number. Run on pull_request / issue_comment events or set the pr-number input."
  exit 2
fi
# Keep the server address and credentials out of (possibly public) logs, even if passed as plain variables.
[[ -n "${DIFF_LEPPARD_API_KEY:-}" ]] && echo "::add-mask::$DIFF_LEPPARD_API_KEY"
[[ -n "${DIFF_LEPPARD_BASE_URL:-}" ]] && echo "::add-mask::$DIFF_LEPPARD_BASE_URL"
if [[ -n "${DIFF_LEPPARD_EXTRA_HEADERS:-}" ]]; then
  node -e 'for (const v of Object.values(JSON.parse(process.argv[1]))) console.log(`::add-mask::${v}`)' "$DIFF_LEPPARD_EXTRA_HEADERS"
fi

args=(pr "$INPUT_PR_NUMBER" --repo "$INPUT_REPOSITORY" --no-prompt --format markdown --output "$RUNNER_TEMP/diff-leppard.json")
case "${INPUT_REVIEW_EVENT:-comment}" in
  comment) args+=(--post) ;;
  request-changes) args+=(--request-changes) ;;
  none | "") ;;
  *) echo "::error::review-event must be comment, request-changes or none"; exit 2 ;;
esac
[[ -n "${INPUT_FAIL_ON:-}" ]] && args+=(--fail-on "$INPUT_FAIL_ON")

report="$RUNNER_TEMP/diff-leppard.md"
set +e
node "$GITHUB_ACTION_PATH/out/src/cli.js" "${args[@]}" >"$report"
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
if [[ $code -eq 1 ]]; then
  echo "::error::Findings at or above '${INPUT_FAIL_ON}' severity."
fi
exit $code
