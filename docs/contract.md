# opengym-ha — interface contract

The single source of truth every component is built against. If code and this file disagree,
this file wins until it is deliberately changed (and every consumer updated in the same commit).

Upstream pin: the openGym release in `opengym/Dockerfile`, as
`ghcr.io/duartesantos8/opengym-{web,api}:<version>@sha256:<multi-arch index digest>` and
`OPENGYM_VERSION=<version>` (`python3 tools/addon_lint.py --upstream-version` prints it). It is
deliberately not repeated here: the Upstream sync workflow moves it on every upstream release.

Both images are pinned only in `opengym/Dockerfile`'s `FROM` lines (the final stage is `FROM` the
api image directly). There is no `build.yaml` (deprecated since Supervisor 2026.04) and no
`ARG BUILD_FROM`: an older Supervisor passes `BUILD_FROM=<HA base image>`, which goes unused.
An Upstream sync commit changes exactly those two lines, `OPENGYM_VERSION` and one changelog
line (`tools/upstream_sync.py`); CI lands it on main only if every job passes on it (§11).

## 1. Processes, ports, users

All three server processes run as **`app` (uid 1000)** via `gosu`, `HOME=/home/app`.
`SUPERVISOR_TOKEN` is removed before `gosu` (`env -u SUPERVISOR_TOKEN gosu app …`), so no server
ever has it in its environment. Supervisor discovery (`node /opt/gateway/src/cli.js discovery`)
is not a server: under the Supervisor it runs as **root**, because any uid-1000 process can read
every other uid-1000 process's `/proc/<pid>/environ`. The boot-time time-zone lookup (`GET /info`) also runs as root, with `env -i` and only `PATH` and
`SUPERVISOR_TOKEN`.

**AppArmor.** The entrypoint and its busybox/gosu helpers run in profile `opengym` (the
Supervisor renames it to the add-on's slug). Every node and nginx process — the api, the
gateway, nginx, the CLI (discovery and the time-zone lookup included) — runs in the child
`<profile>//app`, which has no capabilities and denies `/homeassistant/` and `/homeassistant/**`
(`rwklmx`). The child is indented because the Supervisor requires exactly one column-0 `profile`
line and rewrites only that one. The fence exists only while AppArmor enforces the profile; the
entrypoint logs `WARNING: AppArmor is not enforcing this add-on's profile (…)` at every start
when `/proc/self/attr/current` is not `*opengym* (enforce)`.

| process | listens | owner of the code |
|---|---|---|
| gateway (`node /opt/gateway/src/server.js`) | `0.0.0.0:8099` — ingress port **and** the integration's direct port | ours |
| nginx | `127.0.0.1:8080` | upstream template, our main `nginx.conf` |
| api (`node /app/server.js`) | `127.0.0.1:3000` (`HOST` added by our patch) | upstream + patch |

Request path: client → gateway → nginx → api. The gateway talks **directly** to the api
(`http://127.0.0.1:3000`) only for `/api/health` and `GET/PUT /api/data` on behalf of the
integration, and to the api's **internal unix socket** (§5) for users and sessions.

**Why a unix socket and not a loopback-only route:** nginx is itself on loopback and forwards
every `/api/*` target, so "is the peer 127.0.0.1?" is true for every ingress and LAN request.
The internal listener is a separate `http.Server` on `HA_INTERNAL_SOCKET`
(`/run/opengym/internal.sock`, dir 0700, socket 0600, owned by `app`) that nginx has no route
to. The public TCP server gains **no** routes from our patch.

The gateway **overwrites** `X-Forwarded-For` and `X-Real-IP` with the socket peer and drops
`CF-Connecting-IP` on every proxied request. nginx's main config sets
`set_real_ip_from 127.0.0.1; real_ip_header X-Forwarded-For;` so the upstream template's
`proxy_set_header X-Forwarded-For $remote_addr` forwards the real peer, and the api runs with
`TRUST_PROXY=1`.

## 2. Paths

| path | what |
|---|---|
| `/data/options.json` | Supervisor-written add-on options (read **only** by `gateway/src/options.js`) |
| `/data/opengym/` | upstream `DATA_DIR`: `db.json`, `secret`, `state-<uid>.json`, `vapid.json`, `audit.log`, `uploads/` |
| `/data/gateway/integration_token` | integration token, mode 0600, created once by the gateway at startup, never logged |
| `/run/opengym/internal.sock` | api internal listener (§5); `/run/opengym` created 0700 `app:app` by the entrypoint |
| `/app/` | upstream api (patched at build) — `queue.js` etc. importable from here |
| `/opt/gateway/` | gateway package (`src/`, no `node_modules` needed — zero deps) |
| `/usr/share/nginx/html/` | upstream SPA + `exercise-media/` (copied from the web image) |
| `/usr/share/nginx/html/ha-ingress.js` | the gateway's page-side upload script (`gateway/web/`), loaded first by `index.html` (§6 step 6) |
| `/opt/opengym/integration/opengym/` | root-owned copy of `custom_components/opengym` minus `tests/` and byte-code; kept identical by `tools/sync_integration.py`, enforced by `tools/addon_lint.py` |
| `/homeassistant/` | HA's configuration folder: `config.yaml` `map: [{type: homeassistant_config, read_only: false, path: /homeassistant}]`. Mounted whenever the add-on is installed; reachable only from the `opengym` parent profile (the installer), never from `//app` |
| `/homeassistant/custom_components/opengym/.installed-by-opengym-addon` | the installer's marker: the version it installed, then the sha256 of the `manifest.json` it installed |
| `/run/opengym-discovery/` | root:root 0700, discovery's state dir: the entrypoint copies the integration token into it (reading it as `app`) once the gateway answers `/healthz`; root never opens a path under `/data` |
| `/etc/opengym/nginx/default.conf.template` | upstream `web/nginx.conf.template` verbatim (copied from the web image) |

## 3. Environment

### api (set by the entrypoint)
`DATA_DIR=/data/opengym` `HOST=127.0.0.1` `PORT=3000` `ORIGIN=$RESOLVED_ORIGIN`
`RP_ID=$RESOLVED_RP_ID` `RP_NAME=openGym` `FIRST_USER_ADMIN=1` `TRUST_PROXY=1`
`PASSWORD_LOGIN` `INVITE_ONLY` `ALLOW_GUEST` (each `1`/`0` from RESOLVED_*)
`DEFAULT_LANG` (only exported when non-empty) `HA_INTERNAL_SOCKET=/run/opengym/internal.sock`
`NODE_ENV=production`. Upstream's media limits are left at their defaults (videos 40 MB): big
uploads stream through ingress (§6 step 6) instead of being capped.

### nginx template render (as root, before dropping privileges)
`envsubst '${NGINX_PORT} ${BACKEND} ${PORT} ${RESOLVER} ${CF_CONNECTING_IP} ${BASE_PATH} ${MEDIA_UPLOAD_MAX}'`
with `NGINX_PORT=127.0.0.1:8080 BACKEND=127.0.0.1 PORT=3000 RESOLVER=127.0.0.11 CF_CONNECTING_IP= BASE_PATH= MEDIA_UPLOAD_MAX=48m`.

### gateway
`GATEWAY_PORT=8099` `OPENGYM_DATA_DIR=/data/opengym` `GATEWAY_STATE_DIR=/data/gateway`
`OPENGYM_OPTIONS_FILE=/data/options.json` `UPSTREAM_API_URL=http://127.0.0.1:3000`
`UPSTREAM_WEB_URL=http://127.0.0.1:8080` `UPSTREAM_API_DIR=/app`
`HA_INTERNAL_SOCKET=/run/opengym/internal.sock` `OPENGYM_HA_VERSION=<add-on version>`
`OPENGYM_VERSION=<the pinned upstream release>`

The gateway never reads `db.json` or `secret`: users and sessions come from upstream's own
in-memory state over the internal socket, so `sv` bumps ("sign out everywhere"), disables and
deletes are always current. It only reads `state-<uid>.json` (read-only) for the summary.

## 4. Options → resolved settings (`gateway/src/options.js`)

Precedence: non-empty option in `options.json` → declared default. `""` means unset.

| option | schema | default | resolves to |
|---|---|---|---|
| `external_url` | `str?` | `""` | `RESOLVED_ORIGIN` (`url.origin`), `RESOLVED_RP_ID` (`url.hostname`), `RESOLVED_DIRECT_ACCESS=true`. Empty → `http://localhost:8099`, `localhost`, `false` |
| `password_login` | `bool` | `false` | `RESOLVED_PASSWORD_LOGIN=1/0` |
| `invite_only` | `bool` | `false` | `RESOLVED_INVITE_ONLY=1/0` |
| `allow_guest` | `bool` | `false` | `RESOLVED_ALLOW_GUEST=1/0` |
| `default_lang` | `str?` | `""` | `RESOLVED_DEFAULT_LANG` (tag shape `^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$`) |
| `install_integration` | `bool` | `false` | `RESOLVED_INSTALL_INTEGRATION=true/false` (printed last by `resolve`; a non-boolean is a problem) |

**Installer** (`/usr/local/bin/opengym-install-integration.sh`, run by the entrypoint only when
`RESOLVED_INSTALL_INTEGRATION=true`): root, busybox only, after the options are read and before
any server starts. Copies the bundled integration to `/homeassistant/custom_components/opengym`
only when that is absent or carries the marker with another version; the marker's second line
is the sha256 of the `manifest.json` it installed, and a copy whose `manifest.json` no longer
matches it (or is not a plain file) counts as changed and is left alone; never touches a copy
without the marker (HACS, by hand); refuses a symlinked `custom_components`, `opengym` or marker;
swaps by two renames through `.opengym-addon-new` / `.opengym-addon-old`; one log line per
outcome; always exits 0. Off: nothing touches `/homeassistant`, and turning it off removes
nothing.

`external_url` validation (at use — this function is the only reader): must parse as a URL,
protocol `http:` or `https:`, no userinfo, path `""` or `"/"`, no query, no fragment.
All problems are collected and reported together.

CLI (`node /opt/gateway/src/cli.js <cmd>`):
- `resolve` → prints `RESOLVED_<NAME>=<value>` lines (no secrets, values shell-safe: the
  adapter refuses any value outside `[A-Za-z0-9._:/@-]`), exit 0; on invalid options prints every
  problem to stderr, exit 1.
- `discovery` → Supervisor discovery (§8). Always exits 0; logs why when skipped.

## 5. Internal listener (our patch to upstream `api/server.js`)

Started only when `HA_INTERNAL_SOCKET` is set: unlink a stale socket file, `listen(path)`,
`chmod 0600`. Separate route table; nothing here is reachable over TCP. JSON in/out, upstream's
`readBody`/`json` helpers. Also: `server.listen(PORT, process.env.HOST || undefined)`. The patch
only appends to the end of `server.js` (one hunk, `--fuzz=0`), so it keeps applying as upstream
changes the code above it: verified on 1.4.1 and 1.4.2.

### `POST /internal/ha-session` `{"ha_user_id": string, "name": string}`
- `ha_user_id` must match `^[A-Za-z0-9_-]{1,128}$` else `400`. `name` trimmed, sliced to 40
  chars; empty → `"Home Assistant user"`. Name is only used at creation (a user's own rename in
  openGym wins). No uniqueness check: names only have to be unique among password profiles, and
  an HA-only profile cannot acquire a password without an existing credential.
- Find `user.ha === ha_user_id`; not found → create `{id: randomBytes(12).base64url, name,
  created: ISO, ha}`, `claimFirstAdmin`, push, `saveDb()`, `audit(req, 'auth.register.ok',
  {user, msg: 'ha-ingress'})`. **No `await` between find and `saveDb`** (two concurrent calls
  must yield one profile). Invites not consulted. Disabled users are never re-enabled.
- `200 {"user": {"id","name","admin","disabled"}, "created": bool, "token": string|null}` —
  `token` is upstream's own session (`null` when disabled): `makeSession(user, 'c')`, with `exp`
  moved to now + 60 s and the payload re-signed by upstream's `sign()`. The payload is
  `uid:exp:sv`, or from 1.4.2 `uid:exp:sv:kind`. Kind `c` is a browser cookie's, which upstream
  never renews and never treats as a paired phone; 1.4.1 has no kinds and ignores the argument.
  A payload of any other shape is a `500`, never a guess.

### `POST /internal/session` `{"uid": string}`
For integration writes. `200 {"token": string}` (60 s, minted as above) for an existing, non-disabled user;
`404 {"error":"unknown profile"}` otherwise.

### `GET /internal/users`
`200 {"users": [{"id","name","admin","disabled","ha": string|null}]}` from memory.

## 6. Gateway behaviour

`INGRESS_PEER = "172.30.32.2"` — a constant, **no env override**. Peer =
`req.socket.remoteAddress` with a leading `::ffff:` removed. Unit tests inject the peer function
through `createGateway({ peerOf })`; production always uses the socket.

Server timeouts: `requestTimeout` 30 min (48 MB video uploads), `headersTimeout` 60 s,
`keepAliveTimeout` 65 s (above aiohttp's 15 s reuse window — avoids stale-socket 502s through
the Supervisor). Request and response bodies are streamed, never buffered. Hop-by-hop headers
(RFC 9110 §7.6.1, plus any the `Connection` header names) are not forwarded in either direction.
The request body's framing is kept: when the incoming request carried `Transfer-Encoding`
(Node's parser has already refused one that also has a `Content-Length` or does not end in
`chunked`), the request to nginx carries `Transfer-Encoding: chunked` for every method, so a
body never reaches nginx unframed and cannot be read as a second request on the pooled
connection.

Own routes (all peers): `GET /healthz` (proxies api `/api/health` status + body), `/ha/v1/*` (§7).
Everything else proxies to nginx. On **every** proxied request: delete all `X-Remote-User-*`
headers and `X-OpenGym-Method` before forwarding; overwrite `X-Forwarded-For`/`X-Real-IP` with
the socket peer; drop `CF-Connecting-IP`.

**Ingress peer** (every request, with or without identity):
1. Strip every client `gymsid` / `__Host-gymsid` cookie pair and the `Authorization` header
   (cookies ignore ports — a direct-port sign-in on the same hostname would otherwise ride along).
2. If `X-Remote-User-Id` is present **and** the path starts with `/api/`: `POST
   /internal/ha-session` (at most one in flight per HA id; nothing cached). Name =
   `X-Remote-User-Display-Name` || `X-Remote-User-Name`, re-decoded latin1→utf8 (Node reads
   header bytes as latin1). Token non-null → append `gymsid=<token>` to `Cookie`. Disabled →
   anonymous. Static assets get no session.
3. Never inject a Bearer (upstream skips CSRF for Bearer). For non-GET/HEAD/OPTIONS without a
   `Sec-Fetch-Site` header: if the `Origin` host equals `X-Forwarded-Host`, delete `Origin` (old
   WebKit / companion apps). A `Sec-Fetch-Site` that is present is never touched.
4. Response: `X-Frame-Options` → `SAMEORIGIN`; a CSP of `frame-ancestors 'none'` →
   `frame-ancestors 'self'`; drop `Set-Cookie` for `gymsid` / `__Host-gymsid`; a `Location`
   starting with `/` gets the request's `X-Ingress-Path` prefixed.
5. When a new profile is created and is admin, log `"openGym: HA user <name> is the openGym
   admin (first profile on this instance)"`.
6. **Uploads.** The Supervisor reads every ingress request body into memory, capped at 16 MiB
   (`supervisor/api/__init__.py` `MAX_CLIENT_SIZE`), except a `POST` to an add-on with
   `ingress_stream: true` (set in `config.yaml`), which it streams with no length. Upstream
   uploads media with `PUT /api/media/<sha256>` (`frontend/src/lib/api.js` `apiUpload`, an
   `XMLHttpRequest` looked up at call time; a CI test re-reads upstream's source to pin this).
   `gateway/web/ha-ingress.js`, loaded before the app and active only under
   `/api/hassio_ingress/<token>/`, sends exactly those uploads (same origin, that ingress root's
   `api/media/<64 hex>`, no query) as `POST` with `X-OpenGym-Method: PUT`. For the ingress peer
   only, a `POST` to `^/api/media/[0-9a-f]{64}$` with `X-OpenGym-Method: PUT` goes to nginx as
   `PUT`; nothing else changes method. The Supervisor streams that `POST` with no length, and
   upstream books a body of unknown size at its kind's full cap against the quota
   (`api/media.js` `need = len ?? cap`), so the script also sends `X-OpenGym-Length: <Blob.size>`.
   When the request has no `Content-Length` of its own and the value matches `^[0-9]{1,10}$`, the
   rewritten `PUT` carries it as `Content-Length` and the body is held to exactly that many
   bytes: a longer body is cut off before the extra byte, the last chunk is held back until the
   body ends, and a mismatch is `400 {"error":"the upload was not the size it said it was"}` with
   the upstream request aborted. Both headers are dropped from every request. Upstream's CSRF
   check and its media checks (type sniff, sha256, size, length and quota) then run on that `PUT`
   exactly as on a direct upload.

**Other peers:** `RESOLVED_DIRECT_ACCESS=true` → proxy untouched (upstream sign-in and headers
apply). Off → `403` JSON `{"error":"Direct access is turned off. Open openGym from the Home
Assistant sidebar, or set the add-on's external_url option."}`.

## 7. Integration API (`/ha/v1`)

Auth: `Authorization: Bearer <integration token>` compared in constant time; missing/wrong →
`401 {"error":"unauthorized"}`. Errors are curated strings — never an upstream body or `str(exc)`.

### `GET /ha/v1/health` (no auth)
`200 {"ok": true, "version": "<add-on version>", "opengym_version": "<upstream release>"}`

### `GET /ha/v1/profiles`
`200 {"profiles": [{"id": "…", "name": "Alex", "admin": true}]}` — every user in `db.json`
that is not disabled.

### `GET /ha/v1/summary`
```json
{
  "generated_at": "2026-10-22T10:00:00.000Z",
  "profiles": [{
    "id": "…", "name": "Alex", "admin": true, "unit": "kg",
    "body_weight": {"value": 80.2, "unit": "kg", "date": "2026-10-21", "measured_at": "2026-10-21T05:30:00.000Z"},
    "last_workout": {"id": "…", "date": "2026-10-21", "started_at": "…", "ended_at": "…",
                     "routine_name": "Push A", "duration_min": 52},
    "workouts_this_week": 3,
    "workouts_7d": 4,
    "today": {"date": "2026-10-22", "routine_id": "…", "routine_name": "Pull B", "rest_day": false},
    "rev": 42
  }]
}
```
- Users from `GET /internal/users` (non-disabled); documents read **from disk**
  (`state-<uid>.json`, read-only, mtime-cached) — never `GET /api/data`, which would record a
  sync and make the admin dashboard show every profile "synced" by HA. A user with no state
  file: `unit "kg"`, nulls, zero counts, `today.rest_day true`, `rev 0`.
- Dates are the profile's local dates (`workouts[].d` is already local). "Today"/"this week" use
  the profile's `reminder.tz` when present, else the container `TZ`, else UTC. Week start follows
  upstream's own setting if the profile has one, else Monday.
- `today` = upstream `effectiveRoutineId(S, date)` imported from `${UPSTREAM_API_DIR}/queue.js`.
- `body_weight` = the entry with the latest `d` (tie → latest `t`); `value` in the profile unit.
- Any field the gateway cannot derive is `null`, never invented.

### `POST /ha/v1/profiles/{id}/bodyweight`
Request `{"weight": 80.2, "unit": "kg" | "lb", "date": "YYYY-MM-DD"?, "measured_at": ISO?}`
- `weight` finite, `> 0`, `≤ 700` kg-equivalent; `date` defaults to today in the profile tz.
- Converted to the profile unit with upstream's body-weight rule (0.1 rounding,
  `LB_PER_KG = 2.2046226218`).
- Token from `POST /internal/session`; `GET /api/data` → update that `d` in place (or insert),
  keep the list sorted by `d` → `PUT /api/data` with `baseRev` + `baseWid` (`state._wid`), no
  `stamped` flag (bodyweight is app-merged, not server-stamped). `409` → re-apply onto the
  state in the 409 body (its `_wid`), up to 3 attempts.
- Entry `{d, w, t}`: `w` a Number in `S.unit || "kg"` rounded to 0.1;
  `t = max(Date.now(), old.t + 1, |S.deleted?.bodyweight?.[d]| + 1, S.resetAt + 1)` — `t` is
  the only thing merges and removals compare, so it must win.
- `state` null (profile never synced) → `409 {"error":"This profile has no data yet. Log something
  in openGym as that person (a workout, a weigh-in or any setting), then try again."}` —
  opening the app alone does not create the state document (measured: the first boot only
  GETs; the first PUT follows the first change) — never PUT a skeleton document.
- `200 {"profile_id": "…", "entry": {"date": "…", "value": 80.2, "unit": "kg"}, "rev": 43}`;
  `400` invalid input; `404 {"error":"unknown profile"}`; `409 {"error":"the profile changed
  while saving, try again"}` after retries (or the no-data case above); `502 {"error":"openGym
  is not responding"}`.
- Accepted side effect: the write's `GET /api/data` runs as that profile, so upstream records a
  pull (`notePull`, saved at most every 10 minutes) and the admin dashboard shows the profile as
  synced when HA logs a weigh-in for it. Display-only.
- `body_weight.measured_at` in the summary is the entry's `t` (when it was last written), not a
  measurement time; the request's `measured_at` only chooses the date when `date` is absent.

## 8. Discovery

With `SUPERVISOR_TOKEN` set, the entrypoint waits up to 60 s for the gateway's `/healthz`, copies
the integration token as described in §2, then starts discovery as root with exactly `PATH`,
`SUPERVISOR_TOKEN`, `GATEWAY_PORT=8099` and `GATEWAY_STATE_DIR=/run/opengym-discovery` (without
`SUPERVISOR_TOKEN`, discovery runs as `app` and logs the skip). Discovery sends
`POST http://supervisor/discovery` with `Authorization: Bearer $SUPERVISOR_TOKEN`:
```json
{"service": "opengym", "config": {"host": "<GET /addons/self/info → data.hostname>", "port": 8099, "token": "<integration token>"}}
```
Retries: 6 attempts, exponential backoff (~2 min total). No `SUPERVISOR_TOKEN` → log
"not running under the Supervisor, discovery skipped", exit 0. Hostname lookup failure → log and
skip (never advertise the container id).

## 9. HA integration (`custom_components/opengym`)

Config entry data: manual entries `{"host": str, "port": int, "token": str}`; add-on (hassio)
entries also `"addon_slug": str`, the `HassioServiceInfo.slug` of the add-on whose discovery
created the entry. Base URL `http://{host}:{port}`. Hassio flow unique id `opengym_addon`;
manual flow unique id `"{host}:{port}"`. `hassio_confirm` placeholders are
`{"addon": discovery_info.name, "slug": discovery_info.slug}`.

- **Rediscovery is pinned to the add-on.** When an add-on entry (not ignored) exists and
  `discovery_info.slug != entry.data["addon_slug"]` (a missing slug included), the flow aborts
  `not_opengym_addon` (placeholders `addon`, `slug`), changes nothing and makes no request. For
  the same slug, host/port/token change only when the discovery carries a non-empty token.
- **Manual-entry fold:** with no add-on entry, a manual entry whose host:port matches the
  advertised one (case-insensitive) takes a new non-empty token only after
  `GET /ha/v1/summary` with it succeeds there; otherwise `invalid_auth` / `cannot_connect` and
  nothing changes.
- Whenever a discovery or the fold changes an entry's data, the integration aborts that entry's
  reauth flows, deletes the issue `homeassistant/config_entry_reauth_opengym_<entry_id>`,
  dismisses HA 2024.11's `config_entry_reconfigure` notification once no reauth flow remains,
  and reloads the entry when it is `LOADED`, `SETUP_RETRY` or `SETUP_ERROR`.
- Polls `GET /ha/v1/summary` every 60 s.
- `opengym.log_body_weight`: `unit` is **required** (`kg` | `lb`); nothing is inferred from HA's
  unit system. The integration always sends `date`, in HA's time zone.
  `opengym.get_summary` (`SupportsResponse.ONLY`). Both are callable by any HA user for any
  profile (HA does not isolate non-admin users; documented).
- Event `opengym_workout_completed` `{profile_id, profile_name, date, routine_name,
  duration_min}` fires when a profile's `last_workout` has a new id and is not older, by
  `(date, ended_at)`, than the stored one. A poll whose `last_workout` is null or not an object
  keeps the stored one. No event on the first refresh or for a profile seen for the first time.
  With no earlier workout stored for the profile it fires only if `ended_at` is at most 24 h
  old, or, without a usable `ended_at`, the date is today or yesterday in HA's time zone.

## 10. Versions

Add-on version starts at `0.1.0`; `opengym/config.yaml` `version` ==
`custom_components/opengym/manifest.json` `version` == the bundled
`opengym/integration/opengym/manifest.json` `version` (CI-asserted; the auto-bump writes all of
them and the changelog). Every Supervisor passes
`BUILD_VERSION` and `BUILD_ARCH`; the Dockerfile exports `BUILD_VERSION` as
`OPENGYM_HA_VERSION` and appends it to `ha-ingress.js?v=` so browsers fetch a new copy.

## 11. Decisions recorded

- **Admin:** `panel_admin: false` (every household member gets the panel). `FIRST_USER_ADMIN=1`:
  the first HA user to open openGym becomes its admin — documented ("open it yourself first")
  and logged. Admin "Delete" re-creates an empty profile on that user's next visit; DOCS says
  to use Disable.
- **Coach:** HTTPS providers (Anthropic/OpenAI/Gemini/OpenAI-compatible) work; CLI-spawning
  providers refuse to run unless the api is root (`api/coach/adapters/spawn.js`) — documented,
  the api is not run as root to get around it.
- **Ingress caveats (DOCS):** "Sign out" clears this device and you are signed back in as your HA
  user on the next open; the service worker only registers on https, so no offline mode under
  ingress; openGym shares HA's origin under ingress, so an XSS in openGym could reach HA — the
  same exposure every ingress add-on has.
- **Installing the integration:** HACS is the normal path. `install_integration` (off by default)
  is the alternative the owner chose, with an AppArmor fence: the config-folder mount cannot be
  made conditional on the option, so the servers are confined away from it instead, and the
  protection exists only while AppArmor enforces the profile (documented, and logged when not).
- **Upstream releases land unattended** (the owner's choice over a PR to merge). Upstream sync
  polls hourly and pushes `upstream/opengym-X.Y.Z`; CI runs every job on it, and bump-version
  lands it on main with the version bump only if all pass and main's own
  `upstream_sync.py landable` finds it is exactly that commit. A failure opens an issue and lands
  nothing. Trust: a new upstream release reaches users without review, and two kinds of upstream
  code arrive with it:
  - **upstream's app** (the api's JavaScript, the SPA, the nginx template) is held by the
    privilege model (§1): uid 1000, no `SUPERVISOR_TOKEN`, the AppArmor `//app` fence around
    `/homeassistant`;
  - **upstream's image** is the add-on's base, and nothing holds it. The entrypoint is root on
    upstream's `/bin/sh` and busybox. The time-zone lookup and Supervisor discovery run upstream's
    `node` binary as root with `SUPERVISOR_TOKEN`. With `install_integration` on, that root shell writes into
    `/homeassistant`. A malicious image therefore gets root and that token, inside the
    `opengym` AppArmor profile and the container.

  A review step would add little against the second: nobody audits image layers in a bump PR.
  Closing it means building `FROM` a base this repo chooses and copying only upstream's app
  files in. Only releases are followed, never `edge`, and never a digest re-published under the
  pinned version. The Supervisor takes a backup before an update.
- **Uploads:** streamed (§6 step 6) rather than capping openGym's own limits. A cap would have
  applied to direct access too (it is the api's own setting). `ingress_stream` streams only
  `POST`, hence the method tunnel; it is ingress-only and limited to the one media route.
