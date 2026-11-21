"""Sync published pages from pages/*.json to the remote site."""
import argparse
import json
import pathlib
import sys

from remote import Site


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="pages")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    src = pathlib.Path(args.src)
    if not src.is_dir():
        sys.exit(f"{src} is not a directory")
    pages = [json.loads(p.read_text()) for p in sorted(src.glob("*.json"))]
    site = Site()
    for page in pages:
        if page["status"] == "ready":
            print("publish", page["slug"])
            if args.apply:
                site.publish(page)


if __name__ == "__main__":
    main()
