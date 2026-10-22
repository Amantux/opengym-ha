#!/usr/bin/env python3
"""Lint the openGym add-on and its companion HACS integration before Home Assistant does.

The Supervisor, hassfest and HACS each reject or silently degrade a repo for reasons that only
show up after a user has pulled it. Every rule below caught a real defect in a sibling add-on
(myMeal, HomeHoard; see docs/ha-addon-app-sop.md), and every failure says what to do about it.
All problems are reported together, so one run is enough to fix a tree.

    python tools/addon_lint.py                     # lint this checkout
    python tools/addon_lint.py --root <dir>        # lint another tree (tools/tests does this)
    python tools/addon_lint.py --upstream-version  # print the openGym release the add-on ships

`--upstream-version` uses only the standard library, because CI calls it to pick the upstream
source checkout before any venv exists. The full lint needs PyYAML and Pillow
(tools/requirements-lint.txt), installed in a venv.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import NamedTuple
from urllib.parse import quote

ADDON = "opengym"  # add-on directory and slug
DOMAIN = "opengym"  # integration domain
INGRESS_PORT = 8099  # docs/contract.md §1: the gateway listens here

CONFIG = f"{ADDON}/config.yaml"
DOCKERFILE = f"{ADDON}/Dockerfile"
# The Supervisor's build files (find_one_filetype(path, "build", .json/.yaml/.yml)), deprecated
# since Supervisor 2026.04 (supervisor/apps/build.py); every build setting is in the Dockerfile.
LEGACY_BUILD_FILES = tuple(f"{ADDON}/build.{ext}" for ext in ("yaml", "yml", "json"))
TRANSLATIONS = f"{ADDON}/translations/en.yaml"
MANIFEST = f"custom_components/{DOMAIN}/manifest.json"

# Home Assistant is strict about these, and the add-on store shows a placeholder instead of
# failing when one is missing or the wrong shape.
BRAND_ASSETS = {
    f"{ADDON}/icon.png": (512, 512),
    f"{ADDON}/logo.png": (1024, 340),
    f"custom_components/{DOMAIN}/brand/icon.png": (256, 256),
    f"custom_components/{DOMAIN}/brand/icon@2x.png": (512, 512),
    f"custom_components/{DOMAIN}/brand/logo.png": (512, 170),
    f"custom_components/{DOMAIN}/brand/logo@2x.png": (1024, 340),
}

# hacs.json is a CLOSED schema: an unknown key fails the HACS action. Keys and types copied from
# HACS_MANIFEST_JSON_SCHEMA in hacs/integration custom_components/hacs/utils/validate.py (read
# 2026-10-22, not recalled). `country` may be a string or a list of strings.
HACS_KEYS = {
    "name": str,
    "content_in_root": bool,
    "country": (str, list),
    "filename": str,
    "hacs": str,
    "hide_default_branch": bool,
    "homeassistant": str,
    "persistent_directory": str,
    "render_readme": bool,
    "zip_release": bool,
}

# The two official upstream images. The add-on is built FROM the api image and copies the SPA
# (and the licensed exercise media) out of the web image, so both must be the same release.
UPSTREAM_IMAGE = re.compile(
    r"ghcr\.io/duartesantos8/opengym-(?P<part>api|web)"
    r":(?P<tag>[A-Za-z0-9_][A-Za-z0-9_.-]*)"
    r"(?:@(?P<digest>sha256:[0-9a-f]{64}))?"
)
# A literal OPENGYM_VERSION assignment in the Dockerfile: `ARG|ENV OPENGYM_VERSION=1.4.1` or the
# legacy `ENV OPENGYM_VERSION 1.4.1`. The value must start with a digit so `${OPENGYM_VERSION}`
# pass-throughs are not mistaken for pins.
OPENGYM_VERSION = re.compile(
    r"\bOPENGYM_VERSION(?:\s*=\s*|\s+)[\"']?(?P<value>[0-9][0-9A-Za-z._+-]*)"
)
BUILD_FROM_ARG = re.compile(r"^\s*ARG\s+BUILD_FROM\b", re.IGNORECASE)
FROM_LINE = re.compile(r"^\s*FROM\s+(?:--platform=\S+\s+)?(?P<image>\S+)", re.IGNORECASE)


class Problem(NamedTuple):
    where: str
    what: str
    fix: str


def _code_lines(text: str) -> list[str]:
    """Lines with `#` comments removed (a `#` at the start or after whitespace).

    Dockerfile, YAML and shell all use `#`; an old image reference left in a comment must not
    count as a pin. Image references and versions never contain `#`.
    """
    return [re.sub(r"(^|\s)#.*$", "", line) for line in text.splitlines()]


def _read(root: Path, rel: str, problems: list[Problem]) -> str | None:
    path = root / rel
    if not path.is_file():
        problems.append(Problem(rel, "is missing", f"create {rel}"))
        return None
    return path.read_text(encoding="utf-8")


# --------------------------------------------------------------------------------------------
# Upstream pin (standard library only)
# --------------------------------------------------------------------------------------------


def upstream_version(root: Path, problems: list[Problem]) -> str | None:
    """Return the openGym release both upstream images carry, or None with problems appended.

    CI checks the upstream source out at this release, so the gateway and patch suites always
    test the code the image actually ships; a Dependabot image bump moves both together.
    """
    found: list[Problem] = []
    text = _read(root, DOCKERFILE, found)
    if text is None:
        problems.extend(found)
        return None
    refs = []  # (file, part, tag, digest)
    versions = []  # (file, value)
    for line in _code_lines(text):
        refs += [(DOCKERFILE, m["part"], m["tag"], m["digest"]) for m in UPSTREAM_IMAGE.finditer(line)]
        versions += [(DOCKERFILE, m["value"]) for m in OPENGYM_VERSION.finditer(line)]

    for part in ("api", "web"):
        if not any(r[1] == part for r in refs):
            found.append(Problem(
                DOCKERFILE,
                f"no ghcr.io/duartesantos8/opengym-{part} image reference found",
                "the add-on is built from both official upstream images (api as the base, web "
                "for the SPA and exercise media); reference each as "
                f"ghcr.io/duartesantos8/opengym-{part}:<version>@sha256:<digest>",
            ))
    for rel, part, tag, digest in refs:
        if not digest:
            found.append(Problem(
                rel,
                f"opengym-{part}:{tag} is not pinned by digest",
                f"append @sha256:<digest> (docker buildx imagetools inspect "
                f"ghcr.io/duartesantos8/opengym-{part}:{tag}); a tag alone can be re-pushed, "
                "changing what every user builds",
            ))

    tags = sorted({r[2] for r in refs})
    if len(tags) > 1:
        listed = ", ".join(sorted({f"{rel}: opengym-{part}:{tag}" for rel, part, tag, _ in refs}))
        found.append(Problem(
            DOCKERFILE,
            f"the upstream images carry different version tags ({listed})",
            "api and web are one upstream release and must move together; bump both to the "
            "same version, and OPENGYM_VERSION with them",
        ))

    if not versions:
        found.append(Problem(
            DOCKERFILE,
            "no literal OPENGYM_VERSION found",
            "declare OPENGYM_VERSION=<upstream version> (docs/contract.md §3); the gateway "
            "reports it in /ha/v1/health",
        ))
    if len(tags) == 1:
        for rel, value in versions:
            if value != tags[0]:
                found.append(Problem(
                    rel,
                    f"OPENGYM_VERSION is {value} but the upstream images are {tags[0]}",
                    f"set OPENGYM_VERSION={tags[0]}; it must name the release the images ship",
                ))

    problems.extend(found)
    return tags[0] if len(tags) == 1 and not found else None


# --------------------------------------------------------------------------------------------
# Full lint (PyYAML + Pillow)
# --------------------------------------------------------------------------------------------


def _load_yaml(root: Path, rel: str, problems: list[Problem]) -> dict | None:
    import yaml  # imported here: --upstream-version must run without PyYAML

    text = _read(root, rel, problems)
    if text is None:
        return None
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        problems.append(Problem(rel, f"is not valid YAML: {exc}", "fix the syntax"))
        return None
    if not isinstance(data, dict):
        problems.append(Problem(rel, "is not a YAML mapping", "make the top level a mapping"))
        return None
    return data


def _load_json(root: Path, rel: str, problems: list[Problem]) -> dict | None:
    text = _read(root, rel, problems)
    if text is None:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        problems.append(Problem(rel, f"is not valid JSON: {exc}", "fix the syntax"))
        return None
    if not isinstance(data, dict):
        problems.append(Problem(rel, "is not a JSON object", "make the top level an object"))
        return None
    return data


def check_config(cfg: dict, problems: list[Problem]) -> None:
    if "image" in cfg:
        problems.append(Problem(
            CONFIG,
            "has an image: key",
            "delete it. Without image: the Supervisor builds the add-on locally from "
            f"{DOCKERFILE} on each user's machine. That is required, not a preference: the "
            "exercise media inside the upstream web image is licensed for use within openGym "
            "only, so this project never publishes an image of its own",
        ))
    if cfg.get("ingress") is not True:
        problems.append(Problem(
            CONFIG,
            f"ingress is {cfg.get('ingress')!r}",
            "set ingress: true; openGym is opened from the HA sidebar, and the gateway's "
            "single sign-on only applies to the ingress peer",
        ))
    if cfg.get("ingress_port") != INGRESS_PORT:
        problems.append(Problem(
            CONFIG,
            f"ingress_port is {cfg.get('ingress_port')!r}",
            f"set ingress_port: {INGRESS_PORT}, the gateway's port (docs/contract.md §1)",
        ))
    if cfg.get("panel_admin") is not False:
        problems.append(Problem(
            CONFIG,
            f"panel_admin is {cfg.get('panel_admin', '<unset>')!r}",
            "set panel_admin: false explicitly. Home Assistant defaults it to true, which hides "
            "the openGym panel from every household member who is not an HA admin "
            "(docs/contract.md §11)",
        ))
    options, schema = cfg.get("options") or {}, cfg.get("schema") or {}
    if not isinstance(options, dict) or not isinstance(schema, dict):
        problems.append(Problem(CONFIG, "options/schema are not mappings", "make both mappings"))
        return
    for key in sorted(set(options) - set(schema)):
        problems.append(Problem(
            CONFIG,
            f"option {key!r} has no schema entry",
            f"add {key} under schema: (options and schema must list the same keys, "
            "docs/contract.md §4)",
        ))
    for key in sorted(set(schema) - set(options)):
        problems.append(Problem(
            CONFIG,
            f"schema key {key!r} has no default under options:",
            f'add a default for {key} under options: (use "" for an unset str?); a schema key '
            "without one leaves the Configuration tab invalid on install",
        ))
    if not str(cfg.get("version") or "").strip():
        problems.append(Problem(CONFIG, "has no version", "add version: \"<x.y.z>\""))


def check_translations(root: Path, cfg: dict, problems: list[Problem]) -> None:
    keys = set(cfg.get("options") or {}) | set(cfg.get("schema") or {})
    data = _load_yaml(root, TRANSLATIONS, problems)
    if data is None:
        return
    configuration = data.get("configuration") or {}
    for key in sorted(keys):
        entry = configuration.get(key) if isinstance(configuration, dict) else None
        if not isinstance(entry, dict) or not str(entry.get("name") or "").strip():
            problems.append(Problem(
                TRANSLATIONS,
                f"option {key!r} has no configuration.{key}.name",
                f"add configuration.{key}.name, and a description that explains the "
                "consequence; without them the Configuration tab shows the raw key",
            ))


def check_build(root: Path, problems: list[Problem]) -> None:
    for rel in LEGACY_BUILD_FILES:
        if (root / rel).is_file():
            problems.append(Problem(
                rel,
                "exists",
                "delete it and keep every build setting in the Dockerfile. The Supervisor "
                "deprecated build files in 2026.04 and warns about them on every build, and a "
                "build_from there is a second pin of the api image that Dependabot cannot bump",
            ))
    dockerfile = _read(root, DOCKERFILE, problems)
    if dockerfile is None:
        return
    lines = _code_lines(dockerfile)
    if any(BUILD_FROM_ARG.match(line) for line in lines):
        problems.append(Problem(
            DOCKERFILE,
            "declares ARG BUILD_FROM",
            "remove it and name the api image in the final FROM line. A Supervisor older than "
            "2026.04 that finds no build.yaml passes BUILD_FROM=<Home Assistant's own base "
            "image>, which replaces the ARG's default and builds the add-on on the wrong base",
        ))
    froms = [m["image"] for m in map(FROM_LINE.match, lines) if m]
    final = froms[-1] if froms else ""
    base = UPSTREAM_IMAGE.fullmatch(final)
    if not base or base["part"] != "api":
        problems.append(Problem(
            DOCKERFILE,
            f"the final stage is built FROM {final or '<no FROM line>'}",
            "build it FROM ghcr.io/duartesantos8/opengym-api:<version>@sha256:<digest> "
            "directly: the add-on runs upstream's api, and Dependabot only bumps an image that "
            "a FROM line names",
        ))


def check_versions(cfg: dict, manifest: dict, problems: list[Problem]) -> None:
    if str(cfg.get("version")) != str(manifest.get("version")):
        problems.append(Problem(
            f"{CONFIG} / {MANIFEST}",
            f"version drift: config.yaml={cfg.get('version')} "
            f"manifest.json={manifest.get('version')}",
            "keep them identical (docs/contract.md §10); CI's bump-version job writes both in "
            "one commit, so a hand edit must change both",
        ))


def check_manifest(manifest: dict, problems: list[Problem]) -> None:
    for key in ("domain", "name", "version", "documentation", "issue_tracker", "codeowners"):
        if not manifest.get(key):
            problems.append(Problem(MANIFEST, f"is missing {key}", f"add {key} (HACS requires it)"))
    if manifest.get("domain") != DOMAIN:
        problems.append(Problem(
            MANIFEST,
            f"domain is {manifest.get('domain')!r}",
            f"set domain to {DOMAIN!r}; it must equal the directory name",
        ))
    keys = list(manifest)
    expected = [k for k in ("domain", "name") if k in keys] + sorted(
        k for k in keys if k not in ("domain", "name")
    )
    if keys != expected:
        problems.append(Problem(
            MANIFEST,
            f"keys are ordered {keys}",
            f"reorder to {expected}; hassfest requires domain, name, then alphabetical",
        ))


def check_brand_assets(root: Path, problems: list[Problem]) -> None:
    from PIL import Image, UnidentifiedImageError  # imported here, see the module doc

    for rel, size in BRAND_ASSETS.items():
        path = root / rel
        fix = f"regenerate {rel} as a {size[0]}x{size[1]} RGBA PNG"
        if not path.is_file():
            problems.append(Problem(rel, "is missing", fix))
            continue
        try:
            with Image.open(path) as img:
                actual_size, mode, fmt = img.size, img.mode, img.format
        except (UnidentifiedImageError, OSError):
            problems.append(Problem(rel, "is not a readable image", fix))
            continue
        if fmt != "PNG":
            problems.append(Problem(rel, f"is {fmt}, not PNG", fix))
        if actual_size != size:
            problems.append(Problem(rel, f"is {actual_size[0]}x{actual_size[1]}", fix))
        if mode != "RGBA":
            problems.append(Problem(rel, f"has mode {mode}, not RGBA", fix))


def check_docs(root: Path, version: str, problems: list[Problem]) -> None:
    # The Supervisor renders these as the add-on's Documentation and Changelog tabs.
    for rel in (f"{ADDON}/DOCS.md", f"{ADDON}/CHANGELOG.md"):
        path = root / rel
        if not path.is_file() or path.stat().st_size < 200:
            problems.append(Problem(
                rel,
                "is missing or under 200 bytes",
                "write it; the Supervisor shows it as a tab and an empty tab looks broken",
            ))
    changelog = root / ADDON / "CHANGELOG.md"
    if changelog.is_file():
        text = changelog.read_text(encoding="utf-8")
        if not re.search(rf"^## v?{re.escape(version)}(?![\w.])", text, re.M):
            problems.append(Problem(
                f"{ADDON}/CHANGELOG.md",
                f"has no '## {version}' heading for the version in config.yaml",
                f"add one (or rename '## Unreleased' to '## {version}'); a user offered the "
                "update must see what it contains. CI's bump-version job does this on main",
            ))


def check_repository(root: Path, manifest: dict, problems: list[Problem]) -> str | None:
    repo = _load_yaml(root, "repository.yaml", problems)
    if repo is None:
        return None
    base = str(repo.get("url") or "").rstrip("/")
    if not base:
        problems.append(Problem("repository.yaml", "has no url", "add url: https://github.com/<owner>/<repo>"))
        return None
    for label in ("documentation", "issue_tracker"):
        url = str(manifest.get(label) or "")
        # A bare startswith would accept https://github.com/owner/repo-fork.
        if url != base and not url.startswith((base + "/", base + "#", base + "?")):
            problems.append(Problem(
                MANIFEST,
                f"{label} ({url}) is not under {base}",
                f"point it at {base}; HACS links users there and a wrong repo 404s",
            ))
    return base


def check_hacs(root: Path, problems: list[Problem]) -> None:
    hacs = _load_json(root, "hacs.json", problems)
    if hacs is None:
        return
    for key in ("name", "homeassistant"):
        if not hacs.get(key):
            problems.append(Problem(
                "hacs.json",
                f"is missing {key}",
                f"add {key}" + (" (the minimum HA version CI's 'minimum' leg tests)"
                                if key == "homeassistant" else ""),
            ))
    for key in sorted(set(hacs) - set(HACS_KEYS)):
        problems.append(Problem(
            "hacs.json",
            f"has key {key!r}, which the HACS schema does not allow",
            f"remove it (allowed: {', '.join(sorted(HACS_KEYS))}); the HACS action fails on "
            "unknown keys, and iot_class belongs in manifest.json",
        ))
    for key, kind in HACS_KEYS.items():
        if key in hacs and not isinstance(hacs[key], kind):
            names = " or ".join(t.__name__ for t in (kind if isinstance(kind, tuple) else (kind,)))
            problems.append(Problem("hacs.json", f"{key} is not a {names}",
                                    f"make {key} a {names}"))


def check_readme(root: Path, base: str, problems: list[Problem]) -> None:
    text = _read(root, "README.md", problems)
    if text is None:
        return
    # One click on a My Home Assistant button that names another repo installs someone else's
    # code, so the buttons must point at the repo repository.yaml names.
    add_on = ("https://my.home-assistant.io/redirect/supervisor_add_addon_repository/"
              f"?repository_url={quote(base, safe='')}")
    owner, _, name = base.removeprefix("https://github.com/").partition("/")
    hacs = ("https://my.home-assistant.io/redirect/hacs_repository/"
            f"?owner={owner}&repository={name}&category=integration")
    for label, url in (("add-on repository", add_on), ("HACS", hacs)):
        if url not in text:
            problems.append(Problem(
                "README.md",
                f"has no My Home Assistant {label} button for {base}",
                f"link {url}",
            ))


def lint(root: Path) -> list[Problem]:
    problems: list[Problem] = []
    upstream_version(root, problems)
    check_build(root, problems)
    cfg = _load_yaml(root, CONFIG, problems)
    manifest = _load_json(root, MANIFEST, problems)
    if cfg is not None:
        check_config(cfg, problems)
        check_translations(root, cfg, problems)
        check_docs(root, str(cfg.get("version")), problems)
    if manifest is not None:
        check_manifest(manifest, problems)
        if cfg is not None:
            check_versions(cfg, manifest, problems)
        base = check_repository(root, manifest, problems)
        if base:
            check_readme(root, base, problems)
    check_brand_assets(root, problems)
    check_hacs(root, problems)
    # Several checks read the same file; report a missing one once.
    return list(dict.fromkeys(problems))


def _report(problems: list[Problem], title: str, stream) -> None:
    plural = "s" if len(problems) != 1 else ""
    print(f"{title} FAILED ({len(problems)} problem{plural}):", file=stream)
    for p in problems:
        print(f"  - {p.where}: {p.what}\n      fix: {p.fix}", file=stream)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent,
                        help="repository root to lint (default: this checkout)")
    parser.add_argument("--upstream-version", action="store_true",
                        help="print the openGym version both upstream images carry and exit")
    args = parser.parse_args(argv)
    root = args.root.resolve()

    if args.upstream_version:
        problems: list[Problem] = []
        version = upstream_version(root, problems)
        if version is None:
            # stderr only: CI captures stdout as the version.
            _report(problems, "Upstream pin", sys.stderr)
            return 1
        print(version)
        return 0

    problems = lint(root)
    if problems:
        _report(problems, "Add-on lint", sys.stdout)
        return 1
    cfg_version = (root / CONFIG).read_text(encoding="utf-8")
    m = re.search(r"^version:\s*[\"']?([^\"'\s]+)", cfg_version, re.M)
    print(f"Add-on lint OK: {ADDON} {m[1] if m else '?'} "
          f"(upstream openGym {upstream_version(root, [])})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
