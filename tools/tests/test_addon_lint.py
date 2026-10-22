"""Tests for tools/addon_lint.py.

Each failing case mutates ONE thing in a known-good tree (fixtures.make_valid_tree) and asserts
that exactly the matching problem is reported, so a check that stops firing, or starts firing
on the wrong input, fails here.

    .venv/bin/python -m unittest discover -s tools/tests -v
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import addon_lint  # noqa: E402
import fixtures  # noqa: E402
import sync_integration  # noqa: E402


class LintCase(unittest.TestCase):
    # A case that changes the integration assumes its bundled copy was synced again, as a
    # developer must, so the one problem reported is the one under test. The bundle's own cases
    # turn this off.
    resync_bundle = True

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = fixtures.make_valid_tree(Path(self._tmp.name))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # helpers ---------------------------------------------------------------------------------

    def edit(self, rel: str, old: str, new: str) -> None:
        path = self.root / rel
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text, f"fixture {rel} no longer contains {old!r}")
        path.write_text(text.replace(old, new), encoding="utf-8")

    def edit_json(self, rel: str, change) -> None:
        path = self.root / rel
        data = json.loads(path.read_text(encoding="utf-8"))
        result = change(data)  # mutate in place, or return a replacement dict
        if isinstance(result, dict):
            data = result
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

    def assert_only(self, where: str, *needles: str) -> addon_lint.Problem:
        if self.resync_bundle:
            sync_integration.sync(self.root)
        problems = addon_lint.lint(self.root)
        self.assertEqual(len(problems), 1, f"expected exactly one problem, got {problems}")
        (problem,) = problems
        self.assertIn(where, problem.where)
        for needle in needles:
            self.assertIn(needle, problem.what + " " + problem.fix)
        self.assertTrue(problem.fix.strip(), "every problem must say what to do")
        return problem


class ValidTree(LintCase):
    def test_valid_tree_passes(self):
        self.assertEqual(addon_lint.lint(self.root), [])

    def test_old_reference_in_a_comment_is_ignored(self):
        # The fixture Dockerfile mentions opengym-web:1.3.0 in a comment; a trailing comment
        # must not count either.
        self.edit("opengym/Dockerfile", f"FROM {fixtures.API}\n",
                  f"# was ghcr.io/duartesantos8/opengym-api:1.3.0\nFROM {fixtures.API}\n")
        self.edit("opengym/Dockerfile", "OPENGYM_VERSION=1.4.1", "OPENGYM_VERSION=1.4.1  # opengym-web:1.2.0")
        self.assertEqual(addon_lint.lint(self.root), [])

    def test_unreleased_section_above_the_version_is_fine(self):
        self.edit("opengym/CHANGELOG.md", "## 0.1.0", "## Unreleased\n\n- Next thing.\n\n## 0.1.0")
        self.assertEqual(addon_lint.lint(self.root), [])


class AddonConfig(LintCase):
    def test_image_key_is_rejected(self):
        self.edit("opengym/config.yaml", "slug: opengym\n",
                  "slug: opengym\nimage: ghcr.io/amantux/opengym-{arch}\n")
        problem = self.assert_only("opengym/config.yaml", "image:", "licensed")
        self.assertIn("builds the add-on locally", problem.fix)

    def test_ingress_must_be_true(self):
        self.edit("opengym/config.yaml", "ingress: true", "ingress: false")
        self.assert_only("opengym/config.yaml", "ingress is False")

    def test_ingress_port_must_be_the_gateway(self):
        self.edit("opengym/config.yaml", "ingress_port: 8099", "ingress_port: 8080")
        self.assert_only("opengym/config.yaml", "ingress_port is 8080", "8099")

    def test_panel_admin_unset_is_rejected(self):
        # Home Assistant defaults panel_admin to true, so leaving it out is the bug.
        self.edit("opengym/config.yaml", "panel_admin: false\n", "")
        self.assert_only("opengym/config.yaml", "panel_admin", "explicitly")

    def test_panel_admin_true_is_rejected(self):
        self.edit("opengym/config.yaml", "panel_admin: false", "panel_admin: true")
        self.assert_only("opengym/config.yaml", "panel_admin is True")

    def test_option_without_schema(self):
        self.edit("opengym/config.yaml", "  password_login: bool\n", "")
        self.assert_only("opengym/config.yaml", "option 'password_login' has no schema entry")

    def test_schema_without_option(self):
        self.edit("opengym/config.yaml", '  external_url: ""\n', "")
        self.assert_only("opengym/config.yaml", "schema key 'external_url' has no default")

    def test_option_without_translation(self):
        self.edit("opengym/translations/en.yaml",
                  "  password_login:\n    name: Password sign-in\n", "  password_login:\n")
        self.assert_only("opengym/translations/en.yaml", "password_login")

    def test_missing_translations_file(self):
        (self.root / "opengym/translations/en.yaml").unlink()
        self.assert_only("opengym/translations/en.yaml", "is missing")


class BuildPins(LintCase):
    def test_build_files_are_rejected(self):
        # Deprecated by the Supervisor (2026.04), and a second api pin Dependabot cannot bump.
        for name in ("build.yaml", "build.yml", "build.json"):
            with self.subTest(name=name):
                path = fixtures.write(self.root, f"opengym/{name}", f"build_from:\n  amd64: {fixtures.API}\n")
                problem = self.assert_only(f"opengym/{name}", "exists", "deprecated", "Dependabot")
                self.assertIn("delete it", problem.fix)
                path.unlink()

    def test_build_from_arg_is_rejected(self):
        # Even unused: an older Supervisor passes BUILD_FROM=<HA's base image> without a build.yaml.
        self.edit("opengym/Dockerfile", f"FROM {fixtures.WEB} AS web\n",
                  f"ARG BUILD_FROM={fixtures.API}\nFROM {fixtures.WEB} AS web\n")
        self.assert_only("opengym/Dockerfile", "declares ARG BUILD_FROM", "wrong base")

    def test_build_from_shape_reports_both_problems(self):
        # The shape this repo used to have: the api image only as an ARG default.
        self.edit("opengym/Dockerfile", f"FROM {fixtures.API}\n",
                  f"ARG BUILD_FROM={fixtures.API}\nFROM ${{BUILD_FROM}}\n")
        problems = addon_lint.lint(self.root)
        self.assertEqual(sorted(p.what for p in problems),
                         ["declares ARG BUILD_FROM", "the final stage is built FROM ${BUILD_FROM}"])

    def test_final_stage_must_be_the_api_image(self):
        self.edit("opengym/Dockerfile", f"FROM {fixtures.API}\n",
                  f"FROM {fixtures.API} AS api\nFROM node:22-alpine\n")
        problem = self.assert_only("opengym/Dockerfile", "the final stage is built FROM node:22-alpine")
        self.assertIn("Dependabot only bumps an image that a FROM line names", problem.fix)

    def test_api_and_web_tags_must_match(self):
        self.edit("opengym/Dockerfile", "opengym-web:1.4.1@", "opengym-web:1.5.0@")
        self.assert_only("opengym/Dockerfile", "different version tags",
                         "opengym-web:1.5.0", "opengym-api:1.4.1")

    def test_opengym_version_must_match_the_images(self):
        self.edit("opengym/Dockerfile", "OPENGYM_VERSION=1.4.1", "OPENGYM_VERSION=1.4.0")
        self.assert_only("opengym/Dockerfile", "OPENGYM_VERSION is 1.4.0", "1.4.1")

    def test_opengym_version_must_exist(self):
        self.edit("opengym/Dockerfile", "OPENGYM_VERSION=1.4.1", "OPENGYM_VERSION=${BUILD_VERSION}")
        self.assert_only("opengym/Dockerfile", "no literal OPENGYM_VERSION")

    def test_image_must_be_pinned_by_digest(self):
        self.edit("opengym/Dockerfile", "opengym-web:1.4.1@sha256:e32cae9d2f4aad0c5e1b7888c9bfc712b2306ddfe3c65bc4cfefd4b0002e86d3",
                  "opengym-web:1.4.1")
        self.assert_only("opengym/Dockerfile", "opengym-web:1.4.1 is not pinned by digest")

    def test_web_image_must_be_referenced(self):
        self.edit("opengym/Dockerfile", f"FROM {fixtures.WEB} AS web", "FROM scratch AS web")
        self.assert_only("opengym/Dockerfile", "opengym-web image reference")


class IntegrationMetadata(LintCase):
    def test_version_drift(self):
        self.edit_json("custom_components/opengym/manifest.json",
                       lambda m: m.update(version="0.1.1"))
        self.assert_only("manifest.json", "version drift", "config.yaml=0.1.0",
                         "manifest.json=0.1.1")

    def test_manifest_key_order(self):
        def reorder(m):
            return {"name": m.pop("name"), **m}
        self.edit_json("custom_components/opengym/manifest.json", reorder)
        self.assert_only("manifest.json", "domain, name, then alphabetical")

    def test_manifest_keys_after_name_must_be_alphabetical(self):
        def reorder(m):
            version = m.pop("version")
            return {"domain": m.pop("domain"), "name": m.pop("name"), "version": version, **m}
        self.edit_json("custom_components/opengym/manifest.json", reorder)
        self.assert_only("manifest.json", "reorder to")

    def test_documentation_must_be_under_the_repo(self):
        # A bare startswith() would accept this sibling-named fork.
        self.edit_json("custom_components/opengym/manifest.json",
                       lambda m: m.update(documentation="https://github.com/Amantux/opengym-hax"))
        self.assert_only("manifest.json", "documentation", "is not under")

    def test_issue_tracker_must_be_under_the_repo(self):
        self.edit_json("custom_components/opengym/manifest.json",
                       lambda m: m.update(issue_tracker="https://github.com/someone/else/issues"))
        self.assert_only("manifest.json", "issue_tracker")

    def test_hacs_unknown_key(self):
        self.edit_json("hacs.json", lambda h: h.update(iot_class="local_polling"))
        self.assert_only("hacs.json", "'iot_class'", "manifest.json")

    def test_hacs_requires_homeassistant(self):
        self.edit_json("hacs.json", lambda h: h.pop("homeassistant"))
        self.assert_only("hacs.json", "missing homeassistant")

    def test_hacs_types(self):
        self.edit_json("hacs.json", lambda h: h.update(render_readme="yes"))
        self.assert_only("hacs.json", "render_readme is not a bool")

    def test_readme_buttons_must_point_at_this_repo(self):
        self.edit("README.md", "owner=Amantux&repository=opengym-ha", "owner=Amantux&repository=mymeal")
        self.assert_only("README.md", "HACS button")


class BundledIntegration(LintCase):
    """opengym/integration/opengym: the copy install_integration puts into Home Assistant."""

    BUNDLE = "opengym/integration/opengym"
    resync_bundle = False

    def test_missing_bundle(self):
        shutil.rmtree(self.root / self.BUNDLE)
        problem = self.assert_only(self.BUNDLE, "is missing", "tools/sync_integration.py")
        self.assertIn("built from opengym/ only", problem.fix)

    def test_changed_file(self):
        self.edit(f"{self.BUNDLE}/manifest.json", '"version": "0.1.0"', '"version": "0.0.9"')
        self.assert_only(self.BUNDLE, "manifest.json differs", "tools/sync_integration.py")

    def test_byte_for_byte(self):
        # Same text to a reader, different bytes: still a different file.
        path = self.root / self.BUNDLE / "manifest.json"
        path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
        self.assert_only(self.BUNDLE, "manifest.json differs")

    def test_file_added_to_the_integration_only(self):
        fixtures.write(self.root, "custom_components/opengym/sensor.py", "SENSORS = []\n")
        self.assert_only(self.BUNDLE, "sensor.py is missing from the copy")

    def test_file_left_in_the_copy(self):
        fixtures.write(self.root, f"{self.BUNDLE}/old_platform.py", "x = 1\n")
        self.assert_only(self.BUNDLE, "old_platform.py is in the copy only")

    def test_tests_and_byte_code_are_not_part_of_it(self):
        fixtures.write(self.root, "custom_components/opengym/tests/test_x.py", "def test(): pass\n")
        fixtures.write(self.root, "custom_components/opengym/__pycache__/const.cpython-312.pyc", "x")
        fixtures.write(self.root, f"{self.BUNDLE}/__pycache__/const.cpython-314.pyc", "y")
        self.assertEqual(addon_lint.lint(self.root), [])

    def test_many_differences_are_summarised(self):
        for n in range(7):
            fixtures.write(self.root, f"{self.BUNDLE}/stale_{n}.py", "")
        problem = self.assert_only(self.BUNDLE, "stale_0.py is in the copy only", "and 2 more")
        self.assertNotIn("stale_6.py", problem.what)


class BrandAndDocs(LintCase):
    def test_wrong_size(self):
        fixtures.write_png(self.root, "custom_components/opengym/brand/logo.png", (512, 171))
        self.assert_only("brand/logo.png", "512x171", "512x170")

    def test_not_rgba(self):
        fixtures.write_png(self.root, "opengym/icon.png", (512, 512), mode="RGB")
        self.assert_only("opengym/icon.png", "mode RGB", "RGBA")

    def test_missing_brand_asset(self):
        (self.root / "opengym/logo.png").unlink()
        self.assert_only("opengym/logo.png", "is missing", "1024x340")

    def test_not_an_image(self):
        (self.root / "custom_components/opengym/brand/icon@2x.png").write_text("not a png")
        self.assert_only("brand/icon@2x.png", "not a readable image")

    def test_docs_too_small(self):
        (self.root / "opengym/DOCS.md").write_text("# openGym\n")
        self.assert_only("opengym/DOCS.md", "under 200 bytes")

    def test_changelog_needs_the_version_heading(self):
        self.edit("opengym/CHANGELOG.md", "## 0.1.0", "## 0.0.9")
        self.assert_only("opengym/CHANGELOG.md", "'## 0.1.0'")

    def test_changelog_heading_must_be_the_exact_version(self):
        # "## 0.1.01" (or "## 0.1.0.1") is a different version, not a heading for 0.1.0.
        self.edit("opengym/CHANGELOG.md", "## 0.1.0", "## 0.1.01")
        self.assert_only("opengym/CHANGELOG.md", "'## 0.1.0'")


class CommandLine(LintCase):
    def run_main(self, *args: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = addon_lint.main(["--root", str(self.root), *args])
        return code, out.getvalue(), err.getvalue()

    def test_ok_exit_zero(self):
        code, out, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("Add-on lint OK: opengym 0.1.0 (upstream openGym 1.4.1)", out)

    def test_failure_exit_one_with_fix_lines(self):
        self.edit("opengym/config.yaml", "ingress: true", "ingress: false")
        self.edit("opengym/config.yaml", "panel_admin: false", "panel_admin: true")
        code, out, _ = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("Add-on lint FAILED (2 problems)", out)
        self.assertEqual(out.count("fix: "), 2)

    def test_upstream_version_prints_only_the_version(self):
        code, out, err = self.run_main("--upstream-version")
        self.assertEqual((code, out, err), (0, "1.4.1\n", ""))

    def test_upstream_version_refuses_an_inconsistent_pin(self):
        # CI checks the upstream source out at this value; it must never guess.
        self.edit("opengym/Dockerfile", "opengym-web:1.4.1@", "opengym-web:1.5.0@")
        code, out, err = self.run_main("--upstream-version")
        self.assertEqual((code, out), (1, ""))
        self.assertIn("different version tags", err)

    def test_upstream_version_needs_only_the_standard_library(self):
        # CI runs it on the runner's bare python3, before any venv exists. -I: isolated mode,
        # and the import blocker makes a PyYAML/Pillow import fail loudly.
        script = (
            "import sys\n"
            "class Block:\n"
            "    def find_spec(self, name, path=None, target=None):\n"
            "        if name.split('.')[0] in ('yaml', 'PIL'):\n"
            "            raise ImportError('blocked: ' + name)\n"
            "sys.meta_path.insert(0, Block())\n"
            f"sys.path.insert(0, {str(HERE.parent)!r})\n"
            "import addon_lint\n"
            f"sys.exit(addon_lint.main(['--root', {str(self.root)!r}, '--upstream-version']))\n"
        )
        result = subprocess.run([sys.executable, "-I", "-c", script],
                                capture_output=True, text=True, check=False)
        self.assertEqual((result.returncode, result.stdout), (0, "1.4.1\n"), result.stderr)


if __name__ == "__main__":
    unittest.main()
