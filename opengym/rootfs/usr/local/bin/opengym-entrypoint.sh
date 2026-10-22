#!/bin/sh
# openGym add-on entrypoint. It is PID 1 (config.yaml `init: false`): it prepares /data,
# starts the three servers of contract §1 (api, nginx, gateway), forwards stop signals to
# them, and exits with the real status of whichever one dies first.
#
# Root is used only for what needs root: chowning the Supervisor-managed /data, creating
# /run/opengym and rendering nginx's config into a root-owned file. Every process started
# here runs as `app` (uid 1000) through gosu.
set -eu

# Early stop handling, installed before anything else. PID 1 silently drops a signal it has
# no handler for, so without this a `docker stop` during boot would do nothing and end in
# SIGKILL. This trap only records the request; the checkpoints below act on it (a stop
# during boot exits 0), and `trap shutdown` replaces it once there are children to stop.
STOP_REQUESTED=0
trap 'STOP_REQUESTED=1' TERM INT

API_PID=""
NGINX_PID=""
GATEWAY_PID=""
DISCOVERY_PID=""
SLEEP_PID=""

log() { echo "openGym: $*"; }
fail() { echo "openGym: $*" >&2; exit 1; }

# TERM every child started so far and wait until all of them are gone. A second stop signal
# while waiting is only recorded: re-sending TERM gains nothing, and the Supervisor's
# `timeout` escalates to SIGKILL if something hangs.
stop_children() {
  trap 'STOP_REQUESTED=1' TERM INT
  for pid in "$GATEWAY_PID" "$NGINX_PID" "$API_PID" "$DISCOVERY_PID" "$SLEEP_PID"; do
    if [ -n "$pid" ]; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  # `wait` with no operand returns 0 once no child is left, >128 when a signal cut it short.
  until wait; do :; done
}

checkpoint() {
  if [ "$STOP_REQUESTED" = 1 ]; then
    log "stop requested during startup ($1); exiting."
    stop_children
    exit 0
  fi
}

shutdown() {
  log "stopping."
  stop_children
  exit 0
}

# A server that is no longer running stops the add-on with that server's own exit status
# (128+n when a signal killed it), so the Supervisor log shows the real cause.
check_server() {
  if kill -0 "$2" 2>/dev/null; then return 0; fi
  status=0
  wait "$2" || status=$?
  echo "openGym: $1 exited with status $status; stopping the add-on." >&2
  stop_children
  exit "$status"
}

# Run a gateway command (contract §3 environment) as `app`. It execs, so the caller's pid
# IS the node process: call it only in a subshell, i.e. `gateway_cmd … &` or
# `$(gateway_cmd …)`, never bare (that would replace this PID 1). SUPERVISOR_TOKEN is
# removed here and handed back only to discovery, the one command that needs it.
gateway_cmd() {
  exec gosu app env -u SUPERVISOR_TOKEN \
    GATEWAY_PORT=8099 \
    OPENGYM_DATA_DIR=/data/opengym \
    GATEWAY_STATE_DIR=/data/gateway \
    OPENGYM_OPTIONS_FILE=/data/options.json \
    UPSTREAM_API_URL=http://127.0.0.1:3000 \
    UPSTREAM_WEB_URL=http://127.0.0.1:8080 \
    UPSTREAM_API_DIR=/app \
    HA_INTERNAL_SOCKET=/run/opengym/internal.sock \
    OPENGYM_HA_VERSION="$OPENGYM_HA_VERSION" \
    OPENGYM_VERSION="$OPENGYM_VERSION" \
    "$@"
}

# Upstream's api with the contract §3 environment. Same exec rule as gateway_cmd. HOST
# binds it to loopback (our patch), so only the gateway, nginx and the health probe below
# reach it. DEFAULT_LANG is exported only when an option set it (contract §3).
start_api() {
  if [ -n "$RESOLVED_DEFAULT_LANG" ]; then
    set -- DEFAULT_LANG="$RESOLVED_DEFAULT_LANG"
  else
    set --
  fi
  cd /app
  exec gosu app env -u SUPERVISOR_TOKEN \
    DATA_DIR=/data/opengym \
    HOST=127.0.0.1 \
    PORT=3000 \
    ORIGIN="$RESOLVED_ORIGIN" \
    RP_ID="$RESOLVED_RP_ID" \
    RP_NAME=openGym \
    FIRST_USER_ADMIN=1 \
    TRUST_PROXY=1 \
    PASSWORD_LOGIN="$RESOLVED_PASSWORD_LOGIN" \
    INVITE_ONLY="$RESOLVED_INVITE_ONLY" \
    ALLOW_GUEST="$RESOLVED_ALLOW_GUEST" \
    HA_INTERNAL_SOCKET=/run/opengym/internal.sock \
    NODE_ENV=production \
    "$@" \
    node server.js
}

if [ "$(id -u)" != 0 ]; then
  fail "the add-on must start as root (it chowns /data, then drops to the app user); refusing to start."
fi

# The servers' HOME. gosu 1.19 already takes it from app's passwd entry; it is set here so it
# does not depend on the gosu build (some keep the caller's /root, where uid 1000 cannot write).
export HOME=/home/app

log "add-on ${OPENGYM_HA_VERSION} (openGym ${OPENGYM_VERSION}) starting."

# ---------------------------------------------------------------------------------------
# Data directories. /data is managed by the Supervisor and may arrive root-owned (or from
# an older install), so ownership is fixed here on every boot. A read-only or
# non-chownable mount makes the chown a silent no-op and the first write fails hours later,
# so writability is then verified AS the app user, and boot stops with the path named.
# ---------------------------------------------------------------------------------------
if ! mkdir -p /data/opengym /data/gateway; then
  fail "cannot create /data/opengym and /data/gateway; is /data writable?"
fi
chown -R app:app /data 2>/dev/null || true
# Only the gateway reads its state dir; the integration token inside is 0600 anyway.
chmod 0700 /data/gateway 2>/dev/null || true
for dir in /data/opengym /data/gateway; do
  if ! gosu app test -w "$dir"; then
    echo "openGym: $dir is not writable by the 'app' user (uid 1000)." >&2
    fail "the add-on's data directory must be writable by its app user; refusing to start."
  fi
done
checkpoint "after the data directories"

# ---------------------------------------------------------------------------------------
# Options. options.json is read ONCE, by the gateway's tested adapter (gateway/src/options.js,
# contract §4); the shell never parses it, so the two cannot disagree. Run after the chown so
# the app user can read it. Two guards on the eval: the output is captured first and its
# exit status checked (`eval "$(cmd)"` would swallow it), and only lines of the form
# RESOLVED_NAME=<the adapter's shell-safe characters> survive the filter, so neither a stray
# log line nor a value the adapter should have refused can ever become shell code.
# ---------------------------------------------------------------------------------------
if ! RESOLVED_RAW=$(gateway_cmd node /opt/gateway/src/cli.js resolve); then
  fail "refusing to start: the add-on options are invalid (every problem is listed above). Fix them on the add-on's Configuration tab, then start it again."
fi
RESOLVED=$(printf '%s\n' "$RESOLVED_RAW" | grep -E '^RESOLVED_[A-Z_]*=[A-Za-z0-9._:/@-]*$' || true)
eval "$RESOLVED"
for name in ORIGIN RP_ID DIRECT_ACCESS PASSWORD_LOGIN INVITE_ONLY ALLOW_GUEST; do
  eval "value=\${RESOLVED_$name:-}"
  if [ -z "$value" ]; then
    fail "could not resolve RESOLVED_$name from the add-on options; refusing to start."
  fi
done
RESOLVED_DEFAULT_LANG="${RESOLVED_DEFAULT_LANG:-}"
if [ "$RESOLVED_DIRECT_ACCESS" = true ]; then
  log "direct access on port 8099 is ON for $RESOLVED_ORIGIN (external_url)."
else
  log "direct access is off: openGym opens from the Home Assistant sidebar only."
fi
checkpoint "after reading the options"

# ---------------------------------------------------------------------------------------
# Time zone, best effort; it never blocks or fails boot. openGym stores UTC. TZ is what the
# gateway's summary falls back to for "today" when a profile has no zone of its own. A TZ
# already in the environment wins; otherwise Home Assistant's zone is asked from the
# Supervisor (GET /info -> data.timezone, 3 s timeout). The name is checked against the
# time-zone database before it reaches the environment; the response body is never logged.
# ---------------------------------------------------------------------------------------
if [ -n "${TZ:-}" ]; then
  log "time zone $TZ (from the environment)."
elif [ -z "${SUPERVISOR_TOKEN:-}" ]; then
  log "time zone: not running under the Supervisor; using UTC."
else
  zone=$(gosu app node -e '
fetch("http://supervisor/info", {
  headers: { Authorization: "Bearer " + process.env.SUPERVISOR_TOKEN },
  signal: AbortSignal.timeout(3000),
})
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error("status"))))
  .then((body) => {
    const zone = String((body && body.data && body.data.timezone) || "");
    if (!/^[A-Za-z0-9_+\/-]{1,64}$/.test(zone)) throw new Error("shape");
    new Intl.DateTimeFormat("en", { timeZone: zone }); // RangeError for an unknown zone
    process.stdout.write(zone);
  })
  .catch(() => process.exit(1));
' 2>/dev/null) || zone=""
  if [ -n "$zone" ] && [ -f "/usr/share/zoneinfo/$zone" ]; then
    export TZ="$zone"
    log "time zone $TZ (from Home Assistant)."
  else
    log "time zone: could not read Home Assistant's time zone from the Supervisor; using UTC."
  fi
fi
checkpoint "after the time zone lookup"

# ---------------------------------------------------------------------------------------
# Runtime dir for the api's internal listener (contract §5). 0700 app:app: only the app
# user's processes can reach the socket, and nginx's config has no route to it at all.
# Re-applied every boot: a restarted container keeps its previous /run.
# ---------------------------------------------------------------------------------------
mkdir -p /run/opengym
chown app:app /run/opengym
chmod 0700 /run/opengym

# ---------------------------------------------------------------------------------------
# nginx server block: upstream's own template with EXACTLY the variables upstream's image
# substitutes (contract §3). The explicit list matters: the template is full of nginx's own
# $variables ($host, $remote_addr, $api_upstream, ...), which a bare envsubst would blank.
#   BACKEND=127.0.0.1  an IP literal, so nginx never asks RESOLVER (Docker's embedded DNS
#                      address, which an add-on does not have; the template requires the
#                      directive, nothing queries it)
#   CF_CONNECTING_IP=  empty drops the header, so no client can forge it
#   BASE_PATH=         ingress strips its prefix before the gateway; the app derives its
#                      API address from its own URL
# Rendered as root into a root-owned file, so the app user cannot rewrite nginx's config.
# ---------------------------------------------------------------------------------------
# shellcheck disable=SC2016 # the ${...} below are envsubst's variable list, not expansions
NGINX_PORT=127.0.0.1:8080 BACKEND=127.0.0.1 PORT=3000 RESOLVER=127.0.0.11 \
CF_CONNECTING_IP='' BASE_PATH='' MEDIA_UPLOAD_MAX=48m \
  envsubst '${NGINX_PORT} ${BACKEND} ${PORT} ${RESOLVER} ${CF_CONNECTING_IP} ${BASE_PATH} ${MEDIA_UPLOAD_MAX}' \
  < /etc/opengym/nginx/default.conf.template > /etc/nginx/http.d/opengym.conf
checkpoint "after rendering the nginx config"

# ---------------------------------------------------------------------------------------
# Servers. The api first, and nothing else until it answers /api/health (which also proves
# its data dir is writable): nginx and the gateway in front of a dead api would only turn
# every request into a 502.
# ---------------------------------------------------------------------------------------
start_api &
API_PID=$!
# From here on a stop signal has children to forward to.
trap shutdown TERM INT
if [ "$STOP_REQUESTED" = 1 ]; then shutdown; fi

tries=0
until wget -q -T 2 -O /dev/null http://127.0.0.1:3000/api/health 2>/dev/null; do
  check_server "the openGym api" "$API_PID"
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "openGym: the openGym api did not answer /api/health within about a minute." >&2
    stop_children
    exit 1
  fi
  sleep 1
done
log "api ready on 127.0.0.1:3000."

gosu app env -u SUPERVISOR_TOKEN nginx -e stderr -g 'daemon off;' &
NGINX_PID=$!
gateway_cmd node /opt/gateway/src/server.js &
GATEWAY_PID=$!
log "gateway on port 8099 (ingress), nginx on 127.0.0.1:8080."

# Home Assistant discovery: best effort and backgrounded (HA Core may not be up yet; the
# command waits for the gateway and retries for about two minutes on its own, contract §8).
# It always exits 0 and logs why when it skips, so the loop below only reports a crash.
if [ -n "${SUPERVISOR_TOKEN:-}" ]; then
  gateway_cmd SUPERVISOR_TOKEN="$SUPERVISOR_TOKEN" node /opt/gateway/src/cli.js discovery &
else
  gateway_cmd node /opt/gateway/src/cli.js discovery &
fi
DISCOVERY_PID=$!

# ---------------------------------------------------------------------------------------
# Supervise. Any server exiting stops the others and the add-on, with that server's status.
# `sleep & wait` rather than a plain sleep so a stop signal runs shutdown() at once.
# ---------------------------------------------------------------------------------------
while true; do
  check_server "the openGym api" "$API_PID"
  check_server "nginx" "$NGINX_PID"
  check_server "the gateway" "$GATEWAY_PID"
  if [ -n "$DISCOVERY_PID" ] && ! kill -0 "$DISCOVERY_PID" 2>/dev/null; then
    status=0
    wait "$DISCOVERY_PID" || status=$?
    if [ "$status" != 0 ]; then
      echo "openGym: Home Assistant discovery failed (status $status). Add the openGym" \
           "integration by hand under Settings > Devices & services if it does not appear." >&2
    fi
    DISCOVERY_PID=""
  fi
  sleep 5 &
  SLEEP_PID=$!
  wait "$SLEEP_PID" || true
  SLEEP_PID=""
done
