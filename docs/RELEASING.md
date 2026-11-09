# Releasing Diff Leppard

## Every release

1. Add a section for the version to `CHANGELOG.md`, usually by renaming `## Unreleased` to `## X.Y.Z (date)`.
2. Set the version: run `npm version X.Y.Z --no-git-tag-version`. Also update `version` in `.claude-plugin/plugin.json`, and the pre-commit `rev:` in `README.md` and `skills/diff-leppard/SKILL.md`.
3. `npm test`, then commit, including `dist/`. Push to `main` and wait for CI.
4. Tag it: `git tag -a vX.Y.Z -m "Diff Leppard X.Y.Z" && git push origin vX.Y.Z`.

   The **Release** workflow then:
   - checks the tag matches `package.json`
   - runs the tests
   - builds `diff-leppard.vsix` and `diff-leppard.tgz`
   - creates a **draft** GitHub release with the changelog section as its notes

   Tags with a suffix, such as `v1.2.0-rc.1`, become pre-release drafts.
5. Open the draft on the Releases page, check it, and publish it:
   - **Publish as a normal release.** The workflow publishes everywhere it has a secret for (below) and moves the floating major tag (`v1`). If you want the GitHub Marketplace listing updated, tick **"Publish this Action to the GitHub Marketplace"**.
   - **Publish as a pre-release** for a quiet or internal release. The assets go up on GitHub, but nothing is published to any registry and `v1` doesn't move.

The run summary lists each publish step as ✅ done or ⏭️ skipped (no secret).

## One-time setup for publishing

Add these as repository secrets (Settings → Secrets and variables → Actions). Each one is optional; leave any out and that step is skipped.

- **`NPM_TOKEN`** publishes to npm as [`diff-leppard`](https://www.npmjs.com/package/diff-leppard).
  1. Create an npm account with 2FA.
  2. Create a **granular access token** with read and write access to the `diff-leppard` package. For the first publish, use one that can publish new packages.
  3. Releases are published with npm provenance.
- **`OVSX_PAT`** publishes to [Open VSX](https://open-vsx.org), which Cursor, Windsurf and VSCodium install from.
  1. Sign in at open-vsx.org with GitHub.
  2. Sign the publisher agreement.
  3. Create an access token.
  4. Create the namespace once: `npx ovsx create-namespace georgestephanis -p <token>`.
- **`VSCE_PAT`** publishes to the VS Code Marketplace.
  1. Create the publisher `georgestephanis` at https://marketplace.visualstudio.com/manage.
  2. Create an Azure DevOps personal access token with the **Marketplace → Manage** scope, for all accessible organizations.
- **`GH_EXTENSION_TOKEN`** syncs [`georgestephanis/gh-diff-leppard`](https://github.com/georgestephanis/gh-diff-leppard), so people can run `gh extension install georgestephanis/gh-diff-leppard`.
  1. Create the empty public repo `gh-diff-leppard` with a `main` branch; a README commit is enough.
  2. Create a fine-grained PAT that can access only that repo, with **Contents: read and write**.

  The workflow writes `gh-diff-leppard`, a wrapper pinned to the release (`npx diff-leppard@X.Y.Z`, or the CLI on PATH), plus `README.md` and `LICENSE`. It then tags the repo with the version. Don't edit that repo by hand.

Moving the major tag needs no secret; the workflow's own token does it.
