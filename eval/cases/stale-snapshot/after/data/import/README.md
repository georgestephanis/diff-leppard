# Import data

`rows/` holds one JSON file per article, exported from the old CMS by
`scripts/export_rows.py`. `scripts/import_rows.py` reads it by default.

`state.json` maps source IDs to remote row IDs. It is local run state.

## Cleanup (2026-03)

The old CMS archived 140 articles. We re-exported into a scratch folder
(not committed) and ran `import_rows.py --src /tmp/export --prune --apply`,
which deleted the 140 remote rows and removed them from `state.json`.
The committed `rows/` export was not refreshed.
