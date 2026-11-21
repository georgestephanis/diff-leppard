# Import data

`rows/` holds one JSON file per article, exported from the old CMS by
`scripts/export_rows.py`. `scripts/import_rows.py` reads it by default.

`state.json` maps source IDs to remote row IDs. It is local run state.
