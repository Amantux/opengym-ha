#!/usr/bin/env python3
"""Pull each upstream openGym release into the add-on (the Upstream sync workflow and CI's land).

    python3 tools/upstream_sync.py check                       # a newer release to propose?
    python3 tools/upstream_sync.py apply --version X.Y.Z \\
        --api-digest sha256:<hex> --web-digest sha256:<hex>    # pin it (Dockerfile + CHANGELOG)
    python3 tools/upstream_sync.py landable --base <sha> --candidate <sha>
    gh issue list --json number,title | python3 tools/upstream_sync.py resolved --current X.Y.Z

Upstream is not ours, so it cannot tell us it released: the Upstream sync workflow polls. `check`
asks GitHub for upstream's latest release and GHCR for both images at that tag, and proposes it
only once both are multi-arch indexes for the two add-on archs (upstream publishes the images a
few minutes after the release). `apply` makes the one commit a release needs: the two FROM pins,
OPENGYM_VERSION and a changelog line. CI tests that commit like any other, and its bump-version
job lands it on main only if `landable` (run from main's copy of this file, never the branch's)
finds it is exactly what `apply` makes from main: one commit, those two files, those changes.

Exit codes: 0 done; 1 refused or failed (with the reason on stderr); 3 (`landable` only) main
moved since the candidate was made, so the next sync rebuilds it on the new main.
Standard library only: every caller runs on the runner's own python3.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path

import addon_lint  # its upstream-pin half is standard library only
import bump_version

UPSTREAM_REPO = "DuarteSantos8/openGym"
REGISTRY = "ghcr.io"
IMAGES = {"api": "duartesantos8/opengym-api", "web": "duartesantos8/opengym-web"}
# The add-on's archs (config.yaml) as OCI platforms: every user builds FROM the same index.
PLATFORMS = {("linux", "amd64"), ("linux", "arm64")}
INDEX_TYPES = (
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
)
BRANCH_PREFIX = "upstream/opengym-"
# CI's upstream-failed job builds the same title from the branch name; keep the two in step.
ISSUE_TITLE = "openGym {version} could not be pulled in automatically"
ISSUE_TITLE_RE = re.compile(r"^openGym (\d+\.\d+\.\d+) could not be pulled in automatically$")
# The only files a sync commit may touch.
SYNC_FILES = (addon_lint.DOCKERFILE, bump_version.CHANGELOG)

TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
VERSION = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


class SyncError(Exception):
    """A refusal or failure with a message fit for a CI log."""


# --------------------------------------------------------------------------------------------
# Versions
# --------------------------------------------------------------------------------------------


def parse_version(value: str) -> tuple[int, int, int]:
    m = VERSION.match(value)
    if not m:
        raise SyncError(f"{value!r} is not a release version (X.Y.Z)")
    return int(m[1]), int(m[2]), int(m[3])


def release_url(version: str) -> str:
    # Built here rather than taken from the API response, so nothing upstream sends reaches the
    # changelog except a version that has already matched VERSION.
    return f"https://github.com/{UPSTREAM_REPO}/releases/tag/v{version}"


def commit_subject(old: str, new: str) -> str:
    """The sync commit's subject; a new upstream minor or major is our minor (bump_version)."""
    level = " [minor]" if parse_version(new)[:2] != parse_version(old)[:2] else ""
    return f"Upstream: openGym {old} → {new}{level}"


# --------------------------------------------------------------------------------------------
# Rewrites (pure, so `landable` can re-derive a candidate from main)
# --------------------------------------------------------------------------------------------


def rewrite_dockerfile(text: str, version: str, digests: dict[str, str]) -> str:
    """Point both upstream FROM lines and OPENGYM_VERSION at `version`; nothing else changes."""
    parse_version(version)
    for part in IMAGES:
        if not DIGEST.match(digests.get(part, "")):
            raise SyncError(f"opengym-{part}: {digests.get(part)!r} is not a sha256 digest")
    seen = {part: 0 for part in IMAGES}
    versions = 0
    out = []
    for line in text.splitlines(keepends=True):
        code = addon_lint._code_lines(line)[0] if line.strip() else ""
        if addon_lint.FROM_LINE.match(code):
            m = addon_lint.UPSTREAM_IMAGE.search(code)
            if m:
                part = m["part"]
                seen[part] += 1
                ref = f"{REGISTRY}/{IMAGES[part]}:{version}@{digests[part]}"
                line = line[:m.start()] + ref + line[m.end():]
        elif addon_lint.OPENGYM_VERSION.search(code):
            m = addon_lint.OPENGYM_VERSION.search(code)
            versions += 1
            line = line[:m.start("value")] + version + line[m.end("value"):]
        out.append(line)
    for part, count in seen.items():
        if count != 1:
            raise SyncError(f"{addon_lint.DOCKERFILE}: expected one FROM line for opengym-{part}, "
                            f"found {count}")
    if versions != 1:
        raise SyncError(f"{addon_lint.DOCKERFILE}: expected one OPENGYM_VERSION, found {versions}")
    return "".join(out)


def changelog_entry(version: str) -> str:
    return f"- openGym {version} ([what's new]({release_url(version)}))."


def add_changelog_entry(text: str, version: str) -> str:
    """Add the release's line under '## Unreleased' (made above the newest release if absent)."""
    entry = changelog_entry(version)
    m = bump_version.UNRELEASED.search(text)
    if m:
        following = re.search(r"^## ", text[m.end():], re.M)
        end = m.end() + following.start() if following else len(text)
        body = text[m.end():end].strip("\n")
        if entry in body.splitlines():
            return text
        body = f"{body}\n{entry}" if body else entry
        tail = text[end:]
        return text[:m.end()] + f"\n\n{body}\n" + ("\n" + tail if tail else "")
    first = re.search(r"^## ", text, re.M)
    section = f"## Unreleased\n\n{entry}\n\n"
    if first:
        return text[:first.start()] + section + text[first.start():]
    return text.rstrip("\n") + "\n\n" + section.rstrip("\n") + "\n"


def pinned(dockerfile: str) -> tuple[str, dict[str, str]]:
    """The version and both digests a Dockerfile pins (the candidate side of `landable`)."""
    digests: dict[str, str] = {}
    tags = set()
    for line in addon_lint._code_lines(dockerfile):
        if addon_lint.FROM_LINE.match(line):
            for m in addon_lint.UPSTREAM_IMAGE.finditer(line):
                digests[m["part"]] = m["digest"] or ""
                tags.add(m["tag"])
    if len(tags) != 1 or set(digests) != set(IMAGES):
        raise SyncError(f"{addon_lint.DOCKERFILE}: cannot read one pinned upstream release")
    return tags.pop(), digests


def apply(root: Path, version: str, digests: dict[str, str]) -> tuple[str, str]:
    """Pin `version` in the tree at `root`; returns (old version, commit subject)."""
    problems: list[addon_lint.Problem] = []
    old = addon_lint.upstream_version(root, problems)
    if old is None:
        raise SyncError("; ".join(f"{p.where}: {p.what}" for p in problems))
    if parse_version(version) <= parse_version(old):
        raise SyncError(f"openGym {version} is not newer than the pinned {old}")
    dockerfile = root / addon_lint.DOCKERFILE
    dockerfile.write_text(rewrite_dockerfile(dockerfile.read_text(encoding="utf-8"), version, digests),
                          encoding="utf-8")
    changelog = root / bump_version.CHANGELOG
    changelog.write_text(add_changelog_entry(changelog.read_text(encoding="utf-8"), version),
                         encoding="utf-8")
    problems = []
    if addon_lint.upstream_version(root, problems) != version:
        raise SyncError("the rewritten Dockerfile does not pin "
                        f"{version}: " + "; ".join(p.what for p in problems))
    return old, commit_subject(old, version)


# --------------------------------------------------------------------------------------------
# Upstream (GitHub releases, GHCR)
# --------------------------------------------------------------------------------------------

Fetch = Callable[[str, dict[str, str]], bytes]


def http_get(url: str, headers: dict[str, str]) -> bytes:
    """GET with three tries on network errors and 5xx; a 4xx is final (HTTPError)."""
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "opengym-ha-upstream-sync", **headers})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except urllib.error.HTTPError as err:
            if err.code < 500 or attempt == 2:
                raise
        except urllib.error.URLError:
            if attempt == 2:
                raise
        time.sleep(5 * (attempt + 1))
    raise AssertionError("unreachable")


def latest_release(fetch: Fetch, token: str = "") -> str:
    """Upstream's latest published release (GitHub excludes drafts and prereleases)."""
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    url = f"https://api.github.com/repos/{UPSTREAM_REPO}/releases/latest"
    data = _json(fetch(url, headers), url)
    tag = data.get("tag_name") if isinstance(data, dict) else None
    m = TAG.match(tag) if isinstance(tag, str) else None
    if not m or data.get("draft") or data.get("prerelease"):
        raise SyncError(f"upstream's latest release has an unexpected tag {tag!r}")
    return ".".join(m.groups())


def index_digest(fetch: Fetch, part: str, version: str) -> str | None:
    """The sha256 of the image index `version` names, or None until it serves both archs."""
    repo = IMAGES[part]
    url = f"https://{REGISTRY}/token?scope=repository:{repo}:pull&service={REGISTRY}"
    token = _json(fetch(url, {}), url).get("token")
    if not isinstance(token, str) or not token:
        raise SyncError(f"{url} returned no token")
    try:
        body = fetch(f"https://{REGISTRY}/v2/{repo}/manifests/{version}",
                     {"Authorization": f"Bearer {token}", "Accept": ", ".join(INDEX_TYPES)})
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return None  # the release is out, its images are not yet
        raise
    if not index_serves_archs(body):
        return None
    # GHCR sends no Docker-Content-Digest on a GET; the digest is by definition that of the bytes.
    return "sha256:" + hashlib.sha256(body).hexdigest()


def _json(body: bytes, url: str) -> dict:
    try:
        data = json.loads(body)
    except ValueError:
        raise SyncError(f"{url} did not return JSON") from None
    if not isinstance(data, dict):
        raise SyncError(f"{url} did not return a JSON object")
    return data


def index_serves_archs(body: bytes) -> bool:
    try:
        index = json.loads(body)
    except ValueError:
        return False
    if not isinstance(index, dict) or index.get("mediaType") not in INDEX_TYPES:
        return False  # a single-arch manifest cannot serve both add-on archs
    found = set()
    for entry in index.get("manifests") or []:
        platform = entry.get("platform") if isinstance(entry, dict) else None
        if isinstance(platform, dict):
            found.add((platform.get("os"), platform.get("architecture")))
    return PLATFORMS <= found


def git(root: Path, *args: str, strip: bool = True) -> str:
    out = subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True,
                         text=True).stdout
    return out.strip() if strip else out


def tried_on(root: Path, branch: str) -> str | None:
    """The parent of origin's `branch` (the main it was made from), or None if there is none."""
    if not git(root, "ls-remote", "--heads", "origin", f"refs/heads/{branch}"):
        return None
    git(root, "fetch", "--quiet", "--no-tags", "--depth=2", "origin", f"refs/heads/{branch}")
    return git(root, "rev-parse", "FETCH_HEAD^")


def check(root: Path, fetch: Fetch, token: str, tried: Callable[[str], str | None],
          head: str) -> dict[str, str]:
    problems: list[addon_lint.Problem] = []
    current = addon_lint.upstream_version(root, problems)
    if current is None:
        raise SyncError("; ".join(f"{p.where}: {p.what}" for p in problems))
    latest = latest_release(fetch, token)
    out = {"current": current, "version": latest}
    if parse_version(latest) <= parse_version(current):
        out["action"] = "none"
        out["reason"] = f"openGym {current} is upstream's latest release"
        if latest == current:
            # Not followed: moving to a different image under the same version is exactly the
            # change a digest pin exists to stop. Said, so a re-published release is noticed.
            _, pins = pinned((root / addon_lint.DOCKERFILE).read_text(encoding="utf-8"))
            moved = [f"opengym-{part}" for part in IMAGES
                     if index_digest(fetch, part, latest) not in (None, pins[part])]
            if moved:
                out["reason"] += (f"; upstream re-published {', '.join(moved)}:{latest} under a "
                                  "new digest, which the pin does not follow")
        return out
    branch = BRANCH_PREFIX + latest
    out["branch"] = branch
    if tried(branch) == head:
        out["action"] = "none"
        out["reason"] = (f"{branch} was already made from this main ({head[:12]}); its CI run, "
                         "or the issue it opened, says how it went. A change on main retries it.")
        return out
    digests = {part: index_digest(fetch, part, latest) for part in IMAGES}
    missing = [f"opengym-{part}" for part, digest in digests.items() if digest is None]
    if missing:
        out["action"] = "wait"
        out["reason"] = (f"openGym {latest} is released but {', '.join(missing)} does not yet "
                         "serve linux/amd64 and linux/arm64; the next run looks again")
        return out
    out.update(action="propose", api_digest=digests["api"], web_digest=digests["web"],
               subject=commit_subject(current, latest))
    return out


# --------------------------------------------------------------------------------------------
# Landing (CI's bump-version job, from main's checkout)
# --------------------------------------------------------------------------------------------

MOVED = 3


def landable(root: Path, base: str, candidate: str) -> None:
    """Raise SyncError unless `candidate` is exactly `apply`'s commit on `base`.

    Exit code MOVED (via SystemExit) when the candidate was made from an older main.
    """
    parents = git(root, "rev-list", "--parents", "-n", "1", candidate).split()[1:]
    if len(parents) != 1:
        raise SyncError(f"{candidate[:12]} has {len(parents)} parents; a sync commit has one")
    if parents[0] != base:
        moved = subprocess.run(["git", "-C", str(root), "merge-base", "--is-ancestor", parents[0], base],
                               capture_output=True).returncode == 0
        if moved:
            raise SystemExit(MOVED)
        raise SyncError(f"{candidate[:12]} was not made from main ({base[:12]})")
    changed = git(root, "diff", "--name-only", "--no-renames", base, candidate).splitlines()
    extra = sorted(set(changed) - set(SYNC_FILES))
    if extra:
        raise SyncError(f"{candidate[:12]} changes more than a sync commit may: {', '.join(extra)}")

    def show(rev: str, rel: str) -> str:
        return git(root, "show", f"{rev}:{rel}", strip=False)

    version, digests = pinned(show(candidate, addon_lint.DOCKERFILE))
    old, _ = pinned(show(base, addon_lint.DOCKERFILE))
    if parse_version(version) <= parse_version(old):
        raise SyncError(f"{candidate[:12]} pins openGym {version}, not newer than main's {old}")
    want = {
        addon_lint.DOCKERFILE: rewrite_dockerfile(show(base, addon_lint.DOCKERFILE), version, digests),
        bump_version.CHANGELOG: add_changelog_entry(show(base, bump_version.CHANGELOG), version),
    }
    for rel, text in want.items():
        if show(candidate, rel) != text:
            raise SyncError(f"{candidate[:12]}: {rel} is not what a sync to {version} makes from main")


def resolved(issues: list[dict], current: str) -> list[int]:
    """Open sync-failure issues whose version main now pins (or has passed)."""
    have = parse_version(current)
    numbers = []
    for issue in issues:
        m = ISSUE_TITLE_RE.match(str(issue.get("title", "")))
        if m and parse_version(m[1]) <= have:
            numbers.append(int(issue["number"]))
    return numbers


# --------------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------------


def emit(values: dict[str, str]) -> None:
    for key, value in values.items():
        if "\n" in value:
            raise SyncError(f"output {key} spans lines")
        print(f"{key}={value}")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as fh:
            fh.writelines(f"{key}={value}\n" for key, value in values.items())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check")
    p_apply = sub.add_parser("apply")
    p_apply.add_argument("--version", required=True)
    p_apply.add_argument("--api-digest", required=True)
    p_apply.add_argument("--web-digest", required=True)
    p_land = sub.add_parser("landable")
    p_land.add_argument("--base", required=True)
    p_land.add_argument("--candidate", required=True)
    p_resolved = sub.add_parser("resolved")
    p_resolved.add_argument("--current", required=True)
    args = parser.parse_args(argv)
    root = args.root
    try:
        if args.command == "check":
            token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
            emit(check(root, http_get, token, lambda branch: tried_on(root, branch),
                       git(root, "rev-parse", "HEAD")))
        elif args.command == "apply":
            old, subject = apply(root, args.version, {"api": args.api_digest, "web": args.web_digest})
            emit({"old": old, "version": args.version, "subject": subject})
        elif args.command == "landable":
            landable(root, args.base, args.candidate)
            print(f"{args.candidate[:12]} is exactly a sync commit on {args.base[:12]}")
        elif args.command == "resolved":
            for number in resolved(json.load(sys.stdin), args.current):
                print(number)
    except SyncError as err:
        print(f"upstream_sync: {err}", file=sys.stderr)
        return 1
    except (urllib.error.URLError, subprocess.CalledProcessError) as err:
        # Only the kind and the URL or command: never a response body from upstream.
        what = getattr(err, "url", None) or getattr(err, "cmd", None) or ""
        code = getattr(err, "code", None) or getattr(err, "returncode", None) or ""
        print(f"upstream_sync: {type(err).__name__} {code} {what}".rstrip(), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
