"""Tests for tools/sync_integration.py (the add-on's bundled copy of the integration).

    .venv/bin/python -m unittest discover -s tools/tests -v
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import fixtures  # noqa: E402
import sync_integration  # noqa: E402

SOURCE = sync_integration.SOURCE
BUNDLE = sync_integration.BUNDLE


class Sync(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        fixtures.write_json(self.root, f"{SOURCE}/manifest.json", fixtures.MANIFEST)
        fixtures.write(self.root, f"{SOURCE}/__init__.py", '"""openGym."""\n')
        fixtures.write(self.root, f"{SOURCE}/translations/en.json", "{}\n")
        fixtures.write_png(self.root, f"{SOURCE}/brand/icon.png", (256, 256))
        fixtures.write(self.root, f"{SOURCE}/tests/test_x.py", "def test(): pass\n")
        fixtures.write(self.root, f"{SOURCE}/tests/conftest.py", "\n")
        fixtures.write(self.root, f"{SOURCE}/__pycache__/const.cpython-312.pyc", "x")
        fixtures.write(self.root, f"{SOURCE}/sub/__pycache__/a.cpython-312.pyc", "x")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def bundled(self) -> list[str]:
        base = self.root / BUNDLE
        return sorted(p.relative_to(base).as_posix() for p in base.rglob("*") if p.is_file())

    def test_copies_the_shipped_files_only(self):
        written = sync_integration.sync(self.root)
        expected = ["__init__.py", "brand/icon.png", "manifest.json", "translations/en.json"]
        self.assertEqual(sorted(written), expected)
        self.assertEqual(self.bundled(), expected)
        self.assertEqual(sync_integration.differences(self.root), [])
        for rel in expected:
            self.assertEqual((self.root / BUNDLE / rel).read_bytes(),
                             (self.root / SOURCE / rel).read_bytes(), rel)

    def test_a_file_named_tests_deeper_down_is_shipped(self):
        # Only the integration's own top-level tests/ is left out.
        fixtures.write(self.root, f"{SOURCE}/helpers/tests.py", "X = 1\n")
        sync_integration.sync(self.root)
        self.assertIn("helpers/tests.py", self.bundled())

    def test_rewrites_and_removes_what_is_stale(self):
        sync_integration.sync(self.root)
        fixtures.write(self.root, f"{BUNDLE}/removed_platform.py", "x = 1\n")
        fixtures.write(self.root, f"{SOURCE}/__init__.py", '"""changed."""\n')
        self.assertEqual(sync_integration.differences(self.root),
                         ["__init__.py differs", "removed_platform.py is in the copy only"])
        sync_integration.sync(self.root)
        self.assertNotIn("removed_platform.py", self.bundled())
        self.assertEqual(sync_integration.differences(self.root), [])

    def test_missing_copy_lists_every_file(self):
        self.assertEqual(sync_integration.differences(self.root), [
            "__init__.py is missing from the copy",
            "brand/icon.png is missing from the copy",
            "manifest.json is missing from the copy",
            "translations/en.json is missing from the copy",
        ])

    @unittest.skipIf(os.name == "nt", "symbolic links")
    def test_refuses_a_symbolic_link(self):
        # A link would be copied as the file it points to today and drift silently afterwards.
        (self.root / SOURCE / "link.py").symlink_to(self.root / SOURCE / "__init__.py")
        with self.assertRaises(SystemExit):
            sync_integration.sync(self.root)
        self.assertFalse((self.root / BUNDLE).exists(), "nothing may be written")

    def test_refuses_an_integration_without_a_manifest(self):
        (self.root / SOURCE / "manifest.json").unlink()
        with self.assertRaises(SystemExit):
            sync_integration.sync(self.root)

    def test_main(self):
        with redirect_stdout(io.StringIO()) as out:
            self.assertEqual(sync_integration.main(["--root", str(self.root)]), 0)
        self.assertIn(f"Wrote 4 files to {BUNDLE}", out.getvalue())


if __name__ == "__main__":
    unittest.main()
