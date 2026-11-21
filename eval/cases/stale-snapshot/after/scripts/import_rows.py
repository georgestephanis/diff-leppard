"""Import rows from data/import/rows/*.json into the remote table.

    python3 scripts/import_rows.py            # dry run
    python3 scripts/import_rows.py --apply    # write
    python3 scripts/import_rows.py --prune --apply   # delete rows whose source is gone
"""
import argparse
import json
import pathlib

from remote import Table

REPO = pathlib.Path(__file__).resolve().parent.parent
ROWS_DIR = REPO / "data" / "import" / "rows"
STATE_FILE = REPO / "data" / "import" / "state.json"


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(ROWS_DIR))
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--prune", action="store_true", help="delete remote rows whose source row is gone, and forget them")
    args = ap.parse_args()
    table = Table("articles")
    state = load_state()
    for path in sorted(pathlib.Path(args.src).glob("*.json")):
        row = json.loads(path.read_text())
        sid = str(row["source_id"])
        if sid in state:
            continue  # already imported
        print("create", sid)
        if args.apply:
            state[sid] = table.create(row)
    if args.prune:
        live = {str(json.loads(p.read_text())["source_id"]) for p in pathlib.Path(args.src).glob("*.json")}
        for sid in sorted(set(state) - live):
            print("delete", sid)
            if args.apply:
                table.delete(state[sid])
                del state[sid]
    if args.apply:
        save_state(state)


if __name__ == "__main__":
    main()
