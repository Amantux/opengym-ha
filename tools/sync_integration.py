#!/usr/bin/env python3
"""Copy the HACS integration into the add-on's build context, for install_integration.

    python3 tools/sync_integration.py            # rewrite opengym/integration/opengym
    python3 tools/sync_integration.py --root DIR

The Supervisor builds the add-on from opengym/ alone, so the integration the add-on can install
into Home Assistant (custom_components/opengym) has to sit inside that folder as a copy. The copy
is every file of the integration except its tests and Python byte-code, byte for byte.
tools/addon_lint.py fails when the two differ, and tools/bump_version.py moves the copy's
manifest.json version with the original's. Standard library only.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

SOURCE = "custom_components/opengym"
BUNDLE = "opengym/integration/opengym"


def _shipped(rel: Path) -> bool:
    """Whether a file of the integration belongs in the bundle (and in Home Assistant)."""
    parts = rel.parts
    if parts[0] == "tests":  # the pytest harness; Home Assistant never imports it
        return False
    return "__pycache__" not in parts and rel.suffix != ".pyc"


def files(directory: Path) -> dict[str, Path]:
    """Relative posix path -> file, for every shipped file under `directory`."""
    if not directory.is_dir():
        return {}
    found = {}
    for path in directory.rglob("*"):
        rel = path.relative_to(directory)
        if (path.is_file() or path.is_symlink()) and _shipped(rel):
            found[rel.as_posix()] = path
    return dict(sorted(found.items()))


def differences(root: Path) -> list[str]:
    """What differs between the integration and its bundled copy, as short lines; [] = equal."""
    source, bundle = files(root / SOURCE), files(root / BUNDLE)
    lines = [f"{rel} is missing from the copy" for rel in source if rel not in bundle]
    lines += [f"{rel} is in the copy only" for rel in bundle if rel not in source]
    for rel in source.keys() & bundle.keys():
        a, b = source[rel], bundle[rel]
        if a.is_symlink() or b.is_symlink():
            lines.append(f"{rel} is a symbolic link; the copy must hold plain files")
        elif a.read_bytes() != b.read_bytes():
            lines.append(f"{rel} differs")
    return sorted(lines)


def sync(root: Path) -> list[str]:
    """Rewrite the bundle from the integration; returns the relative paths written."""
    source = files(root / SOURCE)
    if "manifest.json" not in source:
        raise SystemExit(f"{SOURCE}/manifest.json not found; nothing to bundle")
    if any(path.is_symlink() for path in source.values()):
        raise SystemExit(f"{SOURCE} contains a symbolic link; bundle plain files only")
    bundle = root / BUNDLE
    if bundle.is_symlink() or bundle.is_file():
        raise SystemExit(f"{BUNDLE} is not a directory")
    if bundle.exists():
        shutil.rmtree(bundle)
    for rel, path in source.items():
        target = bundle / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(path.read_bytes())
    return list(source)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args(argv)
    written = sync(args.root.resolve())
    print(f"Wrote {len(written)} files to {BUNDLE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
