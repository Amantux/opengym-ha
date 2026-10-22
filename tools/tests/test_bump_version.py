"""Tests for tools/bump_version.py (CI's bump-version job).

    .venv/bin/python -m unittest discover -s tools/tests -v
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import addon_lint  # noqa: E402
import bump_version  # noqa: E402
import fixtures  # noqa: E402


class Level(unittest.TestCase):
    def test_default_is_patch(self):
        self.assertEqual(bump_version.next_version((0, 1, 4), "fix: x"), (0, 1, 5))

    def test_minor_in_subject(self):
        self.assertEqual(bump_version.next_version((0, 1, 4), "feat: y [minor]"), (0, 2, 0))

    def test_major_in_subject_zeroes_the_rest(self):
        self.assertEqual(bump_version.next_version((0, 3, 4), "[major] Stable"), (1, 0, 0))

    def test_marker_is_case_insensitive(self):
        self.assertEqual(bump_version.next_version((0, 1, 4), "feat: y [MINOR]"), (0, 2, 0))

    def test_marker_in_body_only_is_a_patch(self):
        # The myMeal incident: a body that mentions the marker must not bump a level.
        message = "docs: explain releases\n\nAdd [major] or [minor] to the subject to bump."
        self.assertEqual(bump_version.next_version((0, 1, 4), message), (0, 1, 5))


class Changelog(unittest.TestCase):
    BASE = "# Changelog\n\n## 0.1.0\n\n- First release.\n"

    def test_entry_inserted_above_the_latest_release(self):
        text = bump_version.update_changelog(self.BASE, "0.1.1", "chore: deps")
        self.assertEqual(text, "# Changelog\n\n## 0.1.1\n\n- Maintenance release; no "
                               "user-visible change.\n\n## 0.1.0\n\n- First release.\n")

    def test_feat_subject_becomes_the_note(self):
        text = bump_version.update_changelog(self.BASE, "0.1.1",
                                             "feat(gateway): sign in faster.\n\nbody")
        self.assertIn("## 0.1.1\n\n- Sign in faster.\n\n## 0.1.0", text)

    def test_unreleased_is_promoted(self):
        text = self.BASE.replace("## 0.1.0", "## Unreleased\n\n- New sensor.\n\n## 0.1.0")
        result = bump_version.update_changelog(text, "0.1.1", "feat: ignored, notes exist")
        self.assertIn("## 0.1.1\n\n- New sensor.\n\n## 0.1.0", result)
        self.assertNotIn("Unreleased", result)
        self.assertNotIn("ignored", result)

    def test_empty_unreleased_gets_a_note(self):
        text = self.BASE.replace("## 0.1.0", "## Unreleased\n\n## 0.1.0")
        result = bump_version.update_changelog(text, "0.1.1", "chore: x")
        self.assertIn("## 0.1.1\n\n- Maintenance release; no user-visible change.\n", result)
        self.assertNotIn("Unreleased", result)

    def test_existing_heading_is_left_alone(self):
        text = self.BASE.replace("## 0.1.0", "## 0.1.1\n\n- Hand-written.\n\n## 0.1.0")
        self.assertEqual(bump_version.update_changelog(text, "0.1.1", "fix: x"), text)

    def test_no_release_heading_yet(self):
        text = bump_version.update_changelog("# Changelog\n", "0.1.0", "fix: first")
        self.assertEqual(text, "# Changelog\n\n## 0.1.0\n\n- First.\n")


class Bump(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = fixtures.make_valid_tree(Path(self._tmp.name))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_writes_all_three_files_in_lockstep(self):
        config = self.root / "opengym/config.yaml"
        config.write_text(config.read_text().replace('version: "0.1.0"',
                                                     'version: 0.1.0  # set by CI'))
        old, new = bump_version.bump(self.root, "feat: weekly summary [minor]")
        self.assertEqual((old, new), ("0.1.0", "0.2.0"))

        text = config.read_text()
        self.assertIn('version: "0.2.0"  # set by CI\n', text)
        self.assertEqual(text.count("0.2.0"), 1)

        manifest_text = (self.root / "custom_components/opengym/manifest.json").read_text()
        manifest = json.loads(manifest_text)
        self.assertEqual(manifest["version"], "0.2.0")
        self.assertEqual(list(manifest), list(fixtures.MANIFEST), "key order must survive")
        self.assertTrue(manifest_text.endswith("}\n"))

        self.assertIn("## 0.2.0\n\n- Weekly summary.\n",
                      (self.root / "opengym/CHANGELOG.md").read_text())
        # The bumped tree still satisfies the lint: versions equal, changelog heading present.
        self.assertEqual(addon_lint.lint(self.root), [])

    def test_main_writes_github_output(self):
        output = Path(self._tmp.name) / "github_output"
        env = {"COMMIT_MSG": "fix: x", "GITHUB_OUTPUT": str(output)}
        with mock.patch.dict(os.environ, env), redirect_stdout(io.StringIO()) as out:
            self.assertEqual(bump_version.main(["--root", str(self.root)]), 0)
        self.assertEqual(output.read_text(), "old_version=0.1.0\nnew_version=0.1.1\n")
        self.assertIn("Bumped 0.1.0 -> 0.1.1", out.getvalue())

    def test_refuses_a_config_without_a_version(self):
        config = self.root / "opengym/config.yaml"
        config.write_text(config.read_text().replace('version: "0.1.0"\n', ""))
        with self.assertRaises(SystemExit):
            bump_version.bump(self.root, "fix: x")


if __name__ == "__main__":
    unittest.main()
