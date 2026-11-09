# Rolling out Diff Leppard across an organization

There are three ways to run Diff Leppard on many repos. From lightest to strictest:

| | Repos opt in? | Settings live | Plan |
| --- | --- | --- | --- |
| [1. Workflow template](#1-a-workflow-template-repos-opt-in) | Yes, from the Actions tab | Each repo's workflow file | Any |
| [2. Reusable workflow](#2-a-reusable-workflow-one-place-for-settings) | Yes, with a short caller file | One central workflow | Any |
| [3. Required workflow](#3-a-required-workflow-every-repo-no-opt-in) | No, it runs everywhere the ruleset applies | One central workflow | Org rulesets; see below |

All three share the first step. For a single person who wants reviews on every PR that asks for their review, without touching any repo, use [`diff-leppard watch`](../README.md#watch-automatic-reviews-across-all-your-repos) instead.

## 0. Org secrets and variables

Set these once at the org level and share them with the repos that should get reviews:

```bash
gh secret set LLM_BASE_URL --org my-org --visibility selected --repos api,web,worker   # prompts for the value
gh secret set LLM_API_KEY  --org my-org --visibility selected --repos api,web,worker
gh variable set LLM_MODEL  --org my-org --visibility all --body "Qwen/Qwen2.5-Coder-32B-Instruct"
```

`--visibility` can be `all`, `private` (private and internal repos only) or `selected`. Use `selected` or `private` unless every repo, including public ones, should be able to reach your model server.

Keep `LLM_BASE_URL` a **secret**, not a variable, if the address is private. Secrets are masked in logs, and public repos have public logs.

**The runner has to reach the model server.** On GitHub-hosted runners that means a public HTTPS endpoint with an API key, or joining a private network in the job (the example workflow shows Tailscale). The alternative is a [self-hosted runner group](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/managing-access-to-self-hosted-runners-using-groups) on the same network as the model server, limited to the repos that should use it.

## 1. A workflow template: repos opt in

Workflow templates show up under **Actions → New workflow** in every repo in the org.

1. In the org's `.github` repository (GitHub requires it to be public for templates), add `workflow-templates/diff-leppard.yml`: a copy of [`examples/workflows/diff-leppard.yml`](../examples/workflows/diff-leppard.yml).
2. Next to it, add `workflow-templates/diff-leppard.properties.json`:

   ```json
   {
     "name": "Diff Leppard",
     "description": "AI code review on pull requests, using the organization's own model server.",
     "iconName": "octicon code-review",
     "categories": ["Code review"]
   }
   ```

Each repo then gets its own copy of the workflow, so later changes to the template don't reach repos that already added it.

## 2. A reusable workflow: one place for settings

Put [`examples/workflows/diff-leppard-reusable.yml`](../examples/workflows/diff-leppard-reusable.yml) in a central repo, for example `my-org/ci-workflows`. Each repo then needs only a short caller file, shown at the top of that file:

```yaml
jobs:
  review:
    uses: my-org/ci-workflows/.github/workflows/diff-leppard.yml@main
    secrets: inherit
```

The model, severity threshold and any `fail-on` gate are set in the central workflow, so changing them there changes every repo. Callers can override them with `with:` (`model`, `min-severity`, `fail-on`). If the central repo is private, allow other org repos to use it: **Settings → Actions → General → Access**.

Pin `@main` to a tag or SHA if you want repos to pick up changes only when you release them.

## 3. A required workflow: every repo, no opt-in

An **org ruleset** with the **"Require workflows to pass before merging"** rule runs a workflow from a central repo on pull requests in every repo the ruleset targets, without any file in those repos. This replaced GitHub's older "required workflows" feature.

**Check your plan.** Organization rulesets need GitHub Team or Enterprise. GitHub announced the required-workflows rule for Enterprise Cloud, so confirm it's available on your plan in GitHub's docs on [rulesets](https://docs.github.com/en/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization) before you plan around it.

Setup:

1. Put a workflow in a central repo in the **same org**. It can be the single-repo example with only the `pull_request` trigger. The other triggers don't apply to ruleset workflows.
2. **Org Settings → Repository → Rulesets → New branch ruleset.** Target the repos and branches (e.g. the default branch), enable **Require workflows to pass before merging**, and pick the workflow file and ref.
3. Add a `merge_group` trigger if those repos use a merge queue.

Things to decide first:

- **A required review blocks merging whenever it fails.** That includes when the model server is down. Unless you want that, keep `fail-on` empty and add `continue-on-error: true` to the review step, so the check reports but never blocks. Use `fail-on: critical` only once the server is reliable and you trust the model's critical findings.
- **The workflow runs in each target repo,** so it sees that repo's secrets, including the org secrets shared with it. Share `LLM_BASE_URL` and `LLM_API_KEY` with every repo the ruleset targets, or the review fails there.
- **Ruleset workflows don't run on events triggered by `GITHUB_TOKEN`,** for example PRs opened by another workflow.

## Fork PRs and secrets

- **PRs from forks don't get secrets,** so they can't reach the model server. All the example workflows skip fork PRs instead of failing. A maintainer can review one locally: `diff-leppard pr <url> --draft`.
- **Don't switch to `pull_request_target` to get secrets on fork PRs** unless you understand the risk. It runs with secrets and write access on untrusted PRs. Diff Leppard only reads the PR through the API and never checks out or runs its code, so the main risk is an outsider spending your GPU time. If you do it anyway, gate it behind a label that only maintainers can add.
- **Repo config can't redirect reviews.** `.diff-leppard.json` is read from the PR's base branch, and only review preferences are allowed (no `baseUrl`, keys or headers). A PR can't send your org's code or key to another server.
- **Model output is treated as untrusted:** control characters are stripped, and nothing a model writes is executed.
