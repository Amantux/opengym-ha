<p align="center">
  <a href="https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FAmantux%2Fopengym-ha"><img src="https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg" alt="Add add-on repository to My Home Assistant"></a>
  &nbsp;
  <a href="https://my.home-assistant.io/redirect/hacs_repository/?owner=Amantux&repository=opengym-ha&category=integration"><img src="https://my.home-assistant.io/badges/hacs_repository.svg" alt="Add integration to HACS via My Home Assistant"></a>
</p>

<p align="center">
  <sub><b>Left:</b> installs the add-on (runs openGym, signed in as you). <b>Right:</b> installs the HACS integration (sensors, services, an event).<br>
  Most people want <b>both</b>; see <a href="#install">Install</a>.</sub>
</p>

# openGym for Home Assistant

[![HA validate](https://github.com/Amantux/opengym-ha/actions/workflows/ha-validate.yml/badge.svg)](https://github.com/Amantux/opengym-ha/actions/workflows/ha-validate.yml)
[![CI](https://github.com/Amantux/opengym-ha/actions/workflows/ci.yml/badge.svg)](https://github.com/Amantux/opengym-ha/actions/workflows/ci.yml)
[![HACS: custom](https://img.shields.io/badge/HACS-custom-41BDF5.svg)](https://hacs.xyz/docs/faq/custom_repositories)
[![Home Assistant add-on](https://img.shields.io/badge/Home%20Assistant-add--on-41BDF5.svg?logo=home-assistant&logoColor=white)](https://www.home-assistant.io/addons/)
[![Min HA version](https://img.shields.io/badge/Home%20Assistant-%E2%89%A5%202024.11.0-41BDF5.svg)](https://www.home-assistant.io/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

**[openGym](https://github.com/DuarteSantos8/openGym) in your Home Assistant sidebar, already
signed in as you, and wired into your automations.**

openGym, by [Duarte Santos](https://github.com/DuarteSantos8) and its contributors, is a
self-hosted gym and body-weight tracker: plan your week, run guided workouts, log every set and
your weight, synced across your devices. All of that is upstream's work; this repository does
not fork or rebuild it. It adds two things around the official openGym release:

- **An add-on** that runs openGym inside Home Assistant and signs each household member in as
  their own Home Assistant user. openGym normally signs people in with passkeys, which cannot
  work inside the Home Assistant frame; behind ingress, Home Assistant has already
  authenticated the user, so nobody has to sign in twice.
- **An integration** that lets Home Assistant *use* openGym: per-person sensors, a service a
  smart scale can call, and an event when a workout is finished.

## What you get

- **Sign-in via ingress.** Open openGym from the sidebar and you are in. The first time each
  Home Assistant user opens it, they get their own openGym profile. The very first profile on
  the instance becomes openGym's admin, so open it yourself first.
- **Per-person profiles.** Everyone in the household has their own plan, history and body
  weight, each signed in as themselves.
- **Sensors, one device per profile:** Body weight (long-term statistics, so a scale's history
  graphs like any other weight sensor), Last workout, Workouts this week, Workouts last 7 days,
  Today's routine (or "Rest day").
- **Services:** `opengym.log_body_weight` (profile, weight, kg or lb, optional date), for a
  smart-scale automation; `opengym.get_summary`, which returns every profile's summary to a
  script.
- **Event:** `opengym_workout_completed` with the profile, date, routine and duration, for
  "well done" notifications or a light that turns green.
- **Zero setup for the integration.** The add-on announces itself to Home Assistant (Supervisor
  discovery) with its own token; you just confirm.

Direct access from outside Home Assistant (for example, a phone on your LAN) is **off** by
default. Set the add-on's `external_url` option to turn it on; openGym's own sign-in (passkeys,
or a password if you enable `password_login`) then applies there. The add-on's Documentation tab has the details and the
caveats (sign-out under ingress, no offline mode under ingress).

## Install

1. **Add-on:** click the left button above (or *Settings → Add-ons → Add-on store → ⋮ →
   Repositories* and add `https://github.com/Amantux/opengym-ha`), install **openGym**, start
   it, and click **Open Web UI**. The Supervisor builds it on your machine at install (see
   [Licence notes](#licence-notes) for why), which can take a few minutes.
2. **Integration:** click the right button above (needs [HACS](https://hacs.xyz)), download
   **openGym**, restart Home Assistant, then accept the discovered openGym under *Settings →
   Devices & services*. HACS keeps it updated from then on.

   **No HACS?** Turn on the add-on's `install_integration` option and restart the add-on: it
   copies the integration that ships with it into Home Assistant (never over a copy HACS or you
   installed). Restart Home Assistant when the add-on log says so, then accept the discovered
   openGym as above. The add-on's Documentation tab explains what that option can reach.

**Updates.** Each new openGym release reaches the add-on on its own. Within the hour, this
repository tests it against everything the add-on relies on and, if it passes, releases it as
the add-on's next version. Home Assistant shows the update within about three hours, and
updating rebuilds the add-on on your machine from the new release. To have that happen
unattended, turn on **Auto update** on the add-on's page: Home Assistant then installs a
version once it is a day old, after taking a backup.

## openGym's own guides and exercise library

Everything inside the app is upstream openGym, so its own documentation applies as is:

- [User guides](https://github.com/DuarteSantos8/openGym/tree/main/docs): the
  [AI Coach](https://github.com/DuarteSantos8/openGym/blob/main/docs/AI_COACH.md),
  [importing from Strong, Hevy and others](https://github.com/DuarteSantos8/openGym/blob/main/docs/DATA_IMPORTS.md),
  [the phone app](https://github.com/DuarteSantos8/openGym/blob/main/docs/MOBILE.md) and the
  [FAQ](https://github.com/DuarteSantos8/openGym/blob/main/docs/FAQ.md).
- The [exercise library](https://github.com/DuarteSantos8/openGym/blob/main/catalogue/browse/README.md),
  one page per body part, and how to [fix or translate an exercise](https://github.com/DuarteSantos8/openGym/blob/main/catalogue/README.md).
  The add-on already contains all of it, pictures and animations included.
- Bugs inside the app itself belong in [openGym's issues](https://github.com/DuarteSantos8/openGym/issues);
  sign-in, sensors and the add-on belong [here](https://github.com/Amantux/opengym-ha/issues).

## How it works

```
 Home Assistant ingress (peer 172.30.32.2) ─┐
 your LAN, only if external_url is set  ────┴─► gateway  :8099   (ours, Node 22, no dependencies)
                                                  │  ingress user → find or create that user's
                                                  │  profile, attach a short-lived session
                                                  │  /ha/v1/*  → the integration API (token)
                                                  ▼
                                                nginx  127.0.0.1:8080  (upstream's config: SPA + media)
                                                  │  /api/*
                                                  ▼
                                                openGym api  127.0.0.1:3000  (the pinned upstream release + one patch)
                                                  ▲
                         gateway ─────────────────┘  internal unix socket /run/opengym/internal.sock
                                                     (profiles and sessions; nginx has no route to it)
```

- The **gateway** is the only process reachable from outside the container. It trusts Home
  Assistant's identity headers only from the exact ingress peer, strips them from everyone
  else, and never lets a browser's own session cookie ride along under ingress.
- The **patch** (`opengym/patches/`) is small and applied at build with no fuzz: it lets the
  api bind to loopback and adds an internal listener on a unix socket that finds or creates
  the profile for a Home Assistant user. Sessions, CSRF checks, "sign out everywhere" and
  disabling a profile all stay upstream's own code.
- `docs/contract.md` is the interface contract between these pieces.

## Licence notes

- This repository is **AGPL-3.0-or-later**, like openGym itself ([LICENSE](LICENSE)).
- openGym's **exercise media** (stills and animations) are *not* under openGym's AGPL: they are
  licensed to openGym by Gym visual, strictly for use within the openGym application (see
  upstream's [NOTICE.md](https://github.com/DuarteSantos8/openGym/blob/main/NOTICE.md)).
- That is why **this project publishes no container image**. `opengym/config.yaml` has no
  `image:`, so the Supervisor builds the add-on locally, on your machine, `FROM` the official
  openGym images (pinned by digest). The media reach you exactly as openGym ships them, and
  this repository never redistributes them. CI enforces it.

## Development

The same commands CI runs (`.github/workflows/ci.yml`). Node work runs in `node:22-alpine`
containers (the add-on's base runs Node 22); Python work runs in venvs, never the system
interpreter.

```sh
# The upstream source, at the release the add-on ships, without the licensed media.
# Outside this repo; cone mode explicitly, as CI's sparse checkout uses it.
V=$(python3 tools/addon_lint.py --upstream-version)
git clone --depth 1 --filter=blob:none --no-checkout --branch "v$V" \
  https://github.com/DuarteSantos8/openGym ../opengym-upstream
git -C ../opengym-upstream sparse-checkout init --cone
git -C ../opengym-upstream sparse-checkout set api frontend/src/lib frontend/src/locales \
  frontend/src/views web helm kubernetes scripts
git -C ../opengym-upstream checkout

# Gateway tests (CI job: gateway)
docker run --rm -v "$PWD/opengym/gateway:/gw:ro" -v "$PWD/../opengym-upstream:/upstream:ro" \
  -w /gw -e UPSTREAM_API_DIR=/upstream/api -e UPSTREAM_SRC=/upstream node:22-alpine npm test

# Upstream patch + upstream's own api suite (CI job: patch; runs its own container)
bash opengym/patches/run-tests.sh ../opengym-upstream

# Lint (CI job: lint; ha-validate runs the add-on lint too)
uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python -r tools/requirements-lint.txt
.venv/bin/ruff check .
shellcheck opengym/rootfs/usr/local/bin/opengym-entrypoint.sh
.venv/bin/python -m unittest discover -s tools/tests -v
.venv/bin/python tools/addon_lint.py

# Integration tests (CI job: ha-tests; the `minimum` leg uses requirements_test_min.txt on 3.12)
uv venv .venv-ha --python 3.14
uv pip install --python .venv-ha/bin/python -r custom_components/opengym/tests/requirements_test.txt
.venv-ha/bin/python -m pytest custom_components/opengym/tests -q -o asyncio_mode=auto

# Build the image and run the fake-ingress end-to-end suite (CI job: smoke)
bash tests/e2e/run.sh
```

On `main`, CI bumps the patch version after every green push (`[minor]` or `[major]` in the
commit **subject** bumps that instead), keeps `opengym/config.yaml`,
`custom_components/opengym/manifest.json` and `opengym/CHANGELOG.md` in step, and cuts a GitHub
release, which is what HACS offers as an update. A PR that changes shipped code adds its notes
under `## Unreleased` in `opengym/CHANGELOG.md`.

New upstream openGym releases need no one. The *Upstream sync* workflow
(`.github/workflows/upstream-sync.yml`, `tools/upstream_sync.py`) checks hourly and pushes
`upstream/opengym-X.Y.Z`: one commit pinning both images by digest, `OPENGYM_VERSION` and a
changelog line. It then runs CI on that branch, which lands it on `main` and releases it if
every job passes. If something fails, usually the patch no longer applying, CI opens an issue
and `main` is untouched. A fix on `main` retries that release at the next hourly run, and the
issue closes once `main` pins it. GitHub disables a public repository's schedules after 60 days
with no activity: if that happens, re-enable the workflow under *Actions*.

**Pending external step:** registering the `opengym` domain in
[home-assistant/brands](https://github.com/home-assistant/brands). Until then the HACS check
runs with `ignore: brands` (see `.github/workflows/ha-validate.yml`).

Security reports: see [SECURITY.md](.github/SECURITY.md).
