#!/usr/bin/env python3
"""Bump the add-on and integration version in lockstep (CI's bump-version job).

    COMMIT_MSG="$(git log -1 --format=%B)" python3 tools/bump_version.py [--root DIR]

The level comes from the SUBJECT line of the triggering commit only: "[major]" or "[minor]"
bumps that component and zeroes the lower ones; anything else is a patch. Only the subject,
because in myMeal a commit body that merely mentioned "[minor]" once turned a minor release
into 1.0.0.

Writes, in one go: opengym/config.yaml, custom_components/opengym/manifest.json (they must stay
equal, docs/contract.md §10), the add-on's bundled copy of that manifest
(opengym/integration/opengym/manifest.json, which tools/addon_lint.py requires to be identical)
and opengym/CHANGELOG.md (the add-on's Changelog tab must name the version it offers). In CI it
also appends old_version/new_version to $GITHUB_OUTPUT.
Standard library only: the job runs on the runner's own python3.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

CONFIG = "opengym/config.yaml"
MANIFEST = "custom_components/opengym/manifest.json"
BUNDLED_MANIFEST = "opengym/integration/opengym/manifest.json"
CHANGELOG = "opengym/CHANGELOG.md"

# The top-level `version:` key only (no indentation), quoted or not. Only the value is
# rewritten, so a trailing comment on that line survives.
VERSION_LINE = re.compile(r"""^version:[ \t]*(?P<value>["']?(\d+)\.(\d+)\.(\d+)["']?)""", re.M)
UNRELEASED = re.compile(r"^## Unreleased[ \t]*$", re.M)
# Conventional-commit feat/fix subjects become the changelog line; everything else is a
# maintenance release. Same rule as myMeal's bump job.
USER_FACING = re.compile(r"^(feat|fix)(\([^)]*\))?!?:\s*(?P<note>.+)$", re.I)


def subject_of(message: str) -> str:
    return (message.splitlines() or [""])[0].strip()


def next_version(old: tuple[int, int, int], message: str) -> tuple[int, int, int]:
    major, minor, patch = old
    subject = subject_of(message).lower()
    if "[major]" in subject:
        return major + 1, 0, 0
    if "[minor]" in subject:
        return major, minor + 1, 0
    return major, minor, patch + 1


def changelog_note(message: str) -> str:
    m = USER_FACING.match(subject_of(message))
    if not m:
        return "- Maintenance release; no user-visible change."
    note = re.sub(r"\s*\[(major|minor)\]", "", m["note"], flags=re.I).strip().rstrip(".")
    return f"- {note[:1].upper()}{note[1:]}."


def update_changelog(text: str, new: str, message: str) -> str:
    """Give `new` a heading: promote '## Unreleased' if a PR added one, else insert an entry."""
    if re.search(rf"^## v?{re.escape(new)}(?![\w.])", text, re.M):
        return text  # already there (a re-run, or a human wrote it)
    m = UNRELEASED.search(text)
    if m:
        following = re.search(r"^## ", text[m.end():], re.M)
        body_end = m.end() + following.start() if following else len(text)
        heading = f"## {new}"
        if not text[m.end():body_end].strip():
            # An empty Unreleased section would ship a version with no notes.
            heading += f"\n\n{changelog_note(message)}\n"
        return text[:m.start()] + heading + text[m.end():]
    entry = f"## {new}\n\n{changelog_note(message)}\n\n"
    first = re.search(r"^## ", text, re.M)
    if first:
        return text[:first.start()] + entry + text[first.start():]
    return text.rstrip("\n") + "\n\n" + entry.rstrip("\n") + "\n"


def bump(root: Path, message: str) -> tuple[str, str]:
    config_path = root / CONFIG
    config = config_path.read_text(encoding="utf-8")
    m = VERSION_LINE.search(config)
    if not m:
        raise SystemExit(f"{CONFIG}: no top-level 'version: X.Y.Z' line to bump")
    bundled_path = root / BUNDLED_MANIFEST
    if not bundled_path.is_file():  # checked before anything is written
        raise SystemExit(f"{BUNDLED_MANIFEST}: missing; run tools/sync_integration.py first")
    old_parts = tuple(int(x) for x in m.groups()[1:])
    old = ".".join(map(str, old_parts))
    new = ".".join(map(str, next_version(old_parts, message)))

    config_path.write_text(config[:m.start("value")] + f'"{new}"' + config[m.end("value"):],
                           encoding="utf-8")

    manifest_path = root / MANIFEST
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["version"] = new  # key order is preserved; hassfest checks it
    manifest_text = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    manifest_path.write_text(manifest_text, encoding="utf-8")
    # The add-on's copy gets the same bytes, so the two stay identical (tools/sync_integration.py).
    bundled_path.write_text(manifest_text, encoding="utf-8")

    changelog_path = root / CHANGELOG
    changelog = changelog_path.read_text(encoding="utf-8")
    changelog_path.write_text(update_changelog(changelog, new, message), encoding="utf-8")
    return old, new


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args(argv)
    old, new = bump(args.root, os.environ.get("COMMIT_MSG", ""))
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as fh:
            fh.write(f"old_version={old}\nnew_version={new}\n")
    print(f"Bumped {old} -> {new}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
