# Review-quality evaluation

Small cases with known answers, for measuring whether a change to Diff Leppard (prompt, context, verification, model) finds more real problems without reporting more false ones.

```bash
npm run build
npm run eval -- --label my-change                      # every case, your normal config
npm run eval -- --label hunks-only -- --no-context      # anything after -- goes to diff-leppard
npm run eval -- --label other --config ./other.json --cases css-cascade-tie,template-traps
npm run eval -- --label debug --cases template-traps --keep   # keep the throwaway repos and print where each one is
```

It needs a model server, configured as usual (`~/.config/diff-leppard/config.json`, `DIFF_LEPPARD_*`, or `--config`). Each case takes from a few seconds to a few minutes on a 27B model.

For every case the runner commits `before/` and then `after/` into a throwaway git repo and runs `diff-leppard local --range` on it, with `description.md` as the change's title (first line) and description. It prints one line per case and writes `eval/results/<label>.json`:

- **found**: expected findings matched, and how many of the major ones.
- **traps**: findings that must *not* be reported (known false positives) that were.
- **other**: findings that matched nothing. Critical/major ones count as false positives; minor ones are noise.
- **seconds** per case.

Matching is deliberately loose: the file path ends with the expected file, the line is within ±15 of the window, and any keyword appears in the title or body. Always read the findings in the results file too: a keyword match isn't proof the model understood the problem, and if a match looks wrong, fix the keywords.

Compare two configurations by running both with different labels. Results are written to `eval/results/`, which git ignores. No reference results are checked in yet ([#29](https://github.com/georgestephanis/diff-leppard/issues/29)); to add one, use `git add -f` and say which model and settings produced it. Runs vary, so compare several runs of each configuration, not one.

## Cases

| Case | What a good review finds |
| --- | --- |
| `css-cascade-tie` | A new rule ties on specificity with an unchanged rule ~190 lines up and wins on source order, so full-width promos get padding they shouldn't (major). |
| `layout-arithmetic` | A 374px column plus a 120px gap from 769px up leaves the other column far too narrow at tablet widths, given the unchanged 990px container (major). |
| `stale-snapshot` | `--prune` deletes rows and forgets them, but the default source folder predates the cleanup (the README says so), so the next normal run recreates them (major). |
| `weak-safety-check` | "Stale" means "not ready", which also matches published pages flagged for review, with no cap (major); the "new" empty-source guard already existed (minor, description). |
| `template-traps` | Nothing serious. Traps: an `<a href>` that is inside `{% if href %}`, a `<span>` inside `<p>`, a tag whose `>` follows `{% endif %}`, and an `aria-label` that correctly applies only without a visible label. |

## Adding a case

1. `eval/cases/<name>/before/` and `after/`: the files before and after the change. Keep them small and **write them from scratch**; never copy code from a private project. Unchanged files that matter (a README, a data folder) go in both.
2. `description.md`: the change's title on the first line, then the description a PR would have.
3. `expected.json`:

   ```json
   {
     "title": "One line: what this case tests",
     "expected": [
       { "id": "short-id", "severity": "major", "file": "path/in/after.css", "lines": [20, 30], "keywords": ["word", "another"] }
     ],
     "traps": [
       { "id": "trap-id", "file": "templates/x.html", "lines": [1, 20], "keywords": ["what a false report would say"] }
     ]
   }
   ```

   `lines` is the window in the *after* version where the finding should be anchored. Pick keywords that a correct explanation would use and an unrelated finding wouldn't.
4. Run it a few times (`--cases <name>`) to check the keywords catch correct findings and nothing else.
