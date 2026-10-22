"""A minimal repository tree that passes tools/addon_lint.py, built fresh for each test.

Built in code rather than committed so each failing case is one visible mutation of a known-good
tree, and so no second custom_components/opengym/manifest.json sits in the repo for hassfest or
HACS to trip over.
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

API = ("ghcr.io/duartesantos8/opengym-api:1.4.1"
       "@sha256:4bc07fe7d1f05a57c0fa25da3563d54dfe27223506637d67fc64088a2a2f140b")
WEB = ("ghcr.io/duartesantos8/opengym-web:1.4.1"
       "@sha256:e32cae9d2f4aad0c5e1b7888c9bfc712b2306ddfe3c65bc4cfefd4b0002e86d3")

CONFIG = """\
name: openGym
version: "0.1.0"
slug: opengym
description: Self-hosted gym tracker, signed in through Home Assistant
arch:
  - aarch64
  - amd64
ingress: true
ingress_port: 8099
panel_icon: mdi:dumbbell
panel_admin: false
options:
  external_url: ""
  password_login: false
schema:
  external_url: str?
  password_login: bool
"""

DOCKERFILE = f"""\
# syntax=docker/dockerfile:1
# Moved off ghcr.io/duartesantos8/opengym-web:1.3.0 in this commit; a reference in a comment
# must never count as a pin.
FROM {WEB} AS web
FROM {API}
ARG BUILD_VERSION=dev
ENV OPENGYM_HA_VERSION=${{BUILD_VERSION}} \\
    OPENGYM_VERSION=1.4.1
COPY --from=web /usr/share/nginx/html /usr/share/nginx/html
"""

TRANSLATIONS = """\
configuration:
  external_url:
    name: External URL
    description: Lets phones reach openGym directly; leave empty to use the sidebar only.
  password_login:
    name: Password sign-in
    description: Offers password sign-in next to passkeys on the direct port.
"""

MANIFEST = {
    "domain": "opengym",
    "name": "openGym",
    "codeowners": ["@Amantux"],
    "config_flow": True,
    "documentation": "https://github.com/Amantux/opengym-ha",
    "iot_class": "local_polling",
    "issue_tracker": "https://github.com/Amantux/opengym-ha/issues",
    "requirements": [],
    "version": "0.1.0",
}

HACS = {"name": "openGym", "homeassistant": "2024.11.0", "render_readme": True,
        "content_in_root": False}

REPOSITORY = """\
name: openGym for Home Assistant
url: https://github.com/Amantux/opengym-ha
maintainer: Alex Moyse <https://github.com/Amantux>
"""

README = """\
# openGym for Home Assistant

[![Add repository](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FAmantux%2Fopengym-ha)
[![Open in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=Amantux&repository=opengym-ha&category=integration)
"""

DOCS = "# openGym\n\n" + "Open openGym from the Home Assistant sidebar to sign in as yourself. " * 5

CHANGELOG = """\
# Changelog

## 0.1.0

- First release: openGym 1.4.1 in the Home Assistant sidebar, signed in as your HA user, with
  per-person sensors, a body-weight service and a workout-completed event.
- Built locally by the Supervisor from the official openGym images.
"""

BRANDS = {
    "opengym/icon.png": (512, 512),
    "opengym/logo.png": (1024, 340),
    "custom_components/opengym/brand/icon.png": (256, 256),
    "custom_components/opengym/brand/icon@2x.png": (512, 512),
    "custom_components/opengym/brand/logo.png": (512, 170),
    "custom_components/opengym/brand/logo@2x.png": (1024, 340),
}


def write(root: Path, rel: str, text: str) -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def write_json(root: Path, rel: str, data: dict) -> Path:
    return write(root, rel, json.dumps(data, indent=2) + "\n")


def write_png(root: Path, rel: str, size: tuple[int, int], mode: str = "RGBA") -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new(mode, size).save(path, format="PNG")
    return path


def make_valid_tree(root: Path) -> Path:
    write(root, "opengym/config.yaml", CONFIG)
    write(root, "opengym/Dockerfile", DOCKERFILE)
    write(root, "opengym/translations/en.yaml", TRANSLATIONS)
    write(root, "opengym/DOCS.md", DOCS)
    write(root, "opengym/CHANGELOG.md", CHANGELOG)
    write_json(root, "custom_components/opengym/manifest.json", MANIFEST)
    write_json(root, "hacs.json", HACS)
    write(root, "repository.yaml", REPOSITORY)
    write(root, "README.md", README)
    for rel, size in BRANDS.items():
        write_png(root, rel, size)
    return root
