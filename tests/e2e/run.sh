#!/usr/bin/env bash
# End-to-end test of the openGym add-on image behind a fake Home Assistant ingress.
#
#   bash tests/e2e/run.sh                       (CI's smoke job; builds the image first)
#
# It builds the add-on the way the Supervisor does (FROM build.yaml's pinned upstream api
# image, BUILD_VERSION from config.yaml), then on a throwaway Docker network with the hassio
# subnet 172.30.32.0/23:
#   172.30.32.2   fake ingress (nginx): the ONE address the gateway trusts for HA identity
#   172.30.32.3   assertion client (node): any other container on the network
#   172.30.32.4   browser (Playwright), only with E2E_SCREENSHOT_DIR
#   172.30.33.10  the add-on, /data on a fresh volume holding options.json
# and checks ingress sign-in, framing, the direct-access gate, the integration API and its
# body-weight write, process privileges, clean stops, persistence across a restart, the
# external_url mode, and a stop during boot. Every container, the network and the volume are
# removed on exit, pass or fail; logs go to $E2E_OUT first. Exit status 1 if any check failed.
#
# Environment (all optional):
#   E2E_IMAGE            image tag to build/test           (opengym-ha:e2e)
#   E2E_BUILD            1 = build E2E_IMAGE first, 0 = use it as it is   (1)
#   E2E_PREFIX           prefix for container/network/volume names        (opengym-e2e)
#   E2E_OUT              where logs are written            (tests/e2e/out)
#   E2E_NODE_IMAGE       assertion client image            (node:22-alpine)
#   E2E_NGINX_IMAGE      fake ingress image                (nginx:alpine)
#   E2E_SCREENSHOT_DIR   if set: Playwright screenshots through the ingress are saved here
#   E2E_PLAYWRIGHT_IMAGE image with node + the playwright module + Chromium (required with
#                        E2E_SCREENSHOT_DIR; see screenshot.mjs for how it is located)
# Only one run at a time per Docker host: the subnet is fixed by what is being tested.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)

IMAGE=${E2E_IMAGE:-opengym-ha:e2e}
BUILD=${E2E_BUILD:-1}
PREFIX=${E2E_PREFIX:-opengym-e2e}
OUT=${E2E_OUT:-$HERE/out}
NODE_IMAGE=${E2E_NODE_IMAGE:-node:22-alpine}
NGINX_IMAGE=${E2E_NGINX_IMAGE:-nginx:alpine}
SHOTS=${E2E_SCREENSHOT_DIR:-}
PW_IMAGE=${E2E_PLAYWRIGHT_IMAGE:-}

NET=$PREFIX-net
VOL=$PREFIX-data
ADDON=$PREFIX-addon
INGRESS=$PREFIX-ingress
CLIENT=$PREFIX-client
BROWSER=$PREFIX-browser
SEED=$PREFIX-seed
SUBNET=172.30.32.0/23
INGRESS_IP=172.30.32.2
CLIENT_IP=172.30.32.3
BROWSER_IP=172.30.32.4
ADDON_IP=172.30.33.10

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "ok - $*"; }
fail() { FAILED=$((FAILED + 1)); echo "not ok - $*"; }
# check "<description>" <command...>: one assertion, counted, never aborts the run.
check() {
  local desc=$1
  shift
  if "$@"; then pass "$desc"; else fail "$desc"; fi
}
die() {
  echo "FATAL: $*" >&2
  exit 1
}

remove_all() {
  docker rm -f "$BROWSER" "$CLIENT" "$INGRESS" "$ADDON" "$SEED" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  mkdir -p "$OUT"
  docker logs "$ADDON" >"$OUT/addon.log" 2>&1 || true
  docker logs "$INGRESS" >"$OUT/fake-ingress.log" 2>&1 || true
  remove_all
  if [ "$status" -ne 0 ]; then echo "e2e: logs in $OUT" >&2; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$OUT"
: >"$OUT/client.txt"
if [ -n "$SHOTS" ] && [ -z "$PW_IMAGE" ]; then die "E2E_SCREENSHOT_DIR needs E2E_PLAYWRIGHT_IMAGE"; fi

# ---------------------------------------------------------------------------------------
# Build like the Supervisor: build.yaml's base for this machine's arch, config.yaml's version.
# ---------------------------------------------------------------------------------------
VERSION=$(sed -n 's/^version: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' "$REPO/opengym/config.yaml")
[ -n "$VERSION" ] || die "no version in opengym/config.yaml"
if [ "$BUILD" = 1 ]; then
  case "$(uname -m)" in
    x86_64) ARCH=amd64 ;;
    aarch64 | arm64) ARCH=aarch64 ;;
    *) die "unsupported machine $(uname -m)" ;;
  esac
  BUILD_FROM=$(sed -n "s/^  $ARCH: *//p" "$REPO/opengym/build.yaml")
  [ -n "$BUILD_FROM" ] || die "no build_from for $ARCH in opengym/build.yaml"
  echo "e2e: building $IMAGE ($ARCH, $VERSION) FROM $BUILD_FROM"
  if ! docker build --build-arg "BUILD_FROM=$BUILD_FROM" --build-arg "BUILD_VERSION=$VERSION" \
    --build-arg "BUILD_ARCH=$ARCH" -t "$IMAGE" "$REPO/opengym" >"$OUT/build.txt" 2>&1; then
    tail -40 "$OUT/build.txt" >&2
    die "docker build failed (full output in $OUT/build.txt)"
  fi
fi
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE not found (E2E_BUILD=0 needs it built)"
IMAGE_VERSION=$(docker image inspect -f '{{index .Config.Labels "io.hass.version"}}' "$IMAGE")

# ---------------------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------------------
# Write a fixture as the volume's /data/options.json (what the Supervisor does before start).
put_options() {
  docker run --rm -i --name "$SEED" -v "$VOL:/data" --entrypoint sh "$IMAGE" \
    -c 'cat > /data/options.json' <"$HERE/fixtures/$1"
}
# One phase of client.mjs; its ok/not ok lines count towards the totals.
TOKEN=""
EXPECT_A=""
EXPECT_B=""
PHASE_OUT=""
client_phase() {
  local rc=0
  PHASE_OUT=$(docker exec -e TOKEN="$TOKEN" -e EXPECT_VERSION="$VERSION" -e EXPECT_A="$EXPECT_A" \
    -e EXPECT_B="$EXPECT_B" "$CLIENT" node /e2e/client.mjs "$1" 2>&1) || rc=$?
  printf '%s\n' "$PHASE_OUT" | tee -a "$OUT/client.txt" | grep -v '^E2E_IDS ' || true
  local ok bad
  ok=$(printf '%s\n' "$PHASE_OUT" | grep -c '^ok - ' || true)
  bad=$(printf '%s\n' "$PHASE_OUT" | grep -c '^not ok - ' || true)
  PASSED=$((PASSED + ok))
  FAILED=$((FAILED + bad))
  if [ "$rc" -ne 0 ] && [ "$bad" -eq 0 ]; then fail "client phase $1 exited $rc without reporting a failure"; fi
  return 0
}
wait_ready() {
  local before=$FAILED
  client_phase wait
  if [ "$FAILED" -ne "$before" ]; then die "the add-on did not become ready ($1); see $OUT/addon.log"; fi
}
in_addon() { docker exec "$ADDON" "$@"; }
# Log and text matching greps a captured copy through a here-string, never `docker logs |
# grep -q`: under pipefail that pipeline fails whenever grep matches early and docker logs
# then takes a SIGPIPE, so a check would fail on a log that does contain the line.
addon_log() { docker logs "$ADDON" 2>&1; }
log_has() { local l; l=$(addon_log); grep -qxF -- "$1" <<<"$l"; }
log_lacks() { local l; l=$(addon_log); ! grep -qF -- "$1" <<<"$l"; }
text_contains() { grep -qE -- "$2" <<<"$1"; }
text_lacks() { ! grep -qE -- "$2" <<<"$1"; }
count_comm() { awk -v c="$2" '$2 == c' <<<"$1" | wc -l; }
exit_code() { docker inspect -f '{{.State.ExitCode}}' "$ADDON"; }
# docker stop -t 15, then: exit status 0 and stopped well inside the timeout (no SIGKILL).
stop_cleanly() {
  local t0 t1 code
  t0=$(date +%s)
  docker stop -t 15 "$ADDON" >/dev/null
  t1=$(date +%s)
  code=$(exit_code)
  check "$1: docker stop -t 15 exits 0 (got $code)" [ "$code" = 0 ]
  check "$1: stopped in $((t1 - t0)) s, before the 15 s SIGKILL" [ $((t1 - t0)) -lt 15 ]
}
# pid, comm and the four Uid fields of every process in the add-on (from /proc, never the
# cmdline: the scanning shell would match itself).
PROCS_SH=$(cat <<'EOF'
for d in /proc/[0-9]*; do
  c=$(cat "$d/comm" 2>/dev/null) || continue
  u=$(sed -n 's/^Uid:[[:space:]]*//p' "$d/status" 2>/dev/null) || continue
  [ -n "$u" ] && echo "${d#/proc/} $c $u"
done
EOF
)

# ---------------------------------------------------------------------------------------
# Network, volume, fake ingress, client, add-on.
# ---------------------------------------------------------------------------------------
remove_all # leftovers of an aborted earlier run
docker network create --subnet "$SUBNET" --gateway 172.30.32.1 "$NET" >/dev/null \
  || die "cannot create network $NET on $SUBNET (is another run, or a network on that subnet, still up?)"
docker volume create "$VOL" >/dev/null
put_options options-default.json

docker run -d --name "$INGRESS" --network "$NET" --ip "$INGRESS_IP" \
  -v "$HERE/fixtures/fake-ingress.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$HERE/fixtures/fake-ingress-proxy.inc:/etc/nginx/fake-ha-proxy.inc:ro" \
  -v "$HERE/fixtures/panel.html:/usr/share/nginx/fake-ha/panel.html:ro" \
  "$NGINX_IMAGE" >/dev/null
docker run -d --name "$CLIENT" --network "$NET" --ip "$CLIENT_IP" -v "$HERE:/e2e:ro" \
  "$NODE_IMAGE" sleep infinity >/dev/null
# The image's own HEALTHCHECK command, polled every 2 s instead of every minute.
docker run -d --name "$ADDON" --network "$NET" --ip "$ADDON_IP" -v "$VOL:/data" \
  --health-interval 2s --health-start-period 2s "$IMAGE" >/dev/null

echo "# phase 1: first boot, default options (direct access off)"
wait_ready "first boot"
health=starting
for _ in $(seq 1 30); do
  health=$(docker inspect -f '{{.State.Health.Status}}' "$ADDON")
  if [ "$health" != starting ]; then break; fi
  sleep 1
done
check "the image's HEALTHCHECK reports healthy (got $health)" [ "$health" = healthy ]
check "image label io.hass.version ($IMAGE_VERSION) is config.yaml's version ($VERSION)" [ "$IMAGE_VERSION" = "$VERSION" ]
check "the token file is 0600, owned by app (uid 1000)" [ "$(in_addon stat -c '%a %u:%g' /data/gateway/integration_token)" = "600 1000:1000" ]
TOKEN=$(in_addon cat /data/gateway/integration_token)
check "the integration token is non-trivial" [ "${#TOKEN}" -ge 32 ]

client_phase default
ids=$(printf '%s\n' "$PHASE_OUT" | sed -n 's/^E2E_IDS //p')
EXPECT_A=${ids%% *}
EXPECT_B=${ids#* }
if [ -z "$EXPECT_A" ] || [ -z "$EXPECT_B" ]; then die "the default phase produced no profile ids"; fi

check "the log names the first HA user as the openGym admin" \
  log_has "openGym: HA user Alex Example is the openGym admin (first profile on this instance)"
check "no admin line for the second HA user" log_lacks "HA user Zoë"
check "the log says discovery was skipped (no SUPERVISOR_TOKEN)" \
  log_has "openGym discovery: not running under the Supervisor, discovery skipped"
check "the log says direct access is off" \
  log_has "openGym: direct access is off: openGym opens from the Home Assistant sidebar only."
check "the integration token never appears in the log" log_lacks "$TOKEN"

procs=$(in_addon sh -c "$PROCS_SH")
printf '%s\n' "$procs" >"$OUT/processes.txt"
servers=$(printf '%s\n' "$procs" | awk '$2 == "node" || $2 == "nginx"')
check "two node servers (api, gateway) are running" [ "$(count_comm "$servers" node)" -ge 2 ]
check "nginx (master and worker) is running" [ "$(count_comm "$servers" nginx)" -ge 2 ]
check "every node and nginx process runs as uid 1000 (real, effective, saved, fs)" \
  [ -z "$(printf '%s\n' "$servers" | awk '!($3 == 1000 && $4 == 1000 && $5 == 1000 && $6 == 1000)')" ]
SECRET_SUM=$(in_addon sha256sum /data/opengym/secret | cut -d' ' -f1)

if [ -n "$SHOTS" ]; then
  echo "# screenshots through the fake ingress"
  mkdir -p "$SHOTS"
  shots_rc=0
  shots_out=$(docker run --rm --name "$BROWSER" --network "$NET" --ip "$BROWSER_IP" \
    -v "$HERE:/e2e:ro" -v "$SHOTS:/screens" --entrypoint node "$PW_IMAGE" /e2e/screenshot.mjs /screens 2>&1) || shots_rc=$?
  printf '%s\n' "$shots_out" | tee "$OUT/screenshots.txt"
  PASSED=$((PASSED + $(printf '%s\n' "$shots_out" | grep -c '^ok - ' || true)))
  FAILED=$((FAILED + $(printf '%s\n' "$shots_out" | grep -c '^not ok - ' || true)))
  if [ "$shots_rc" -ne 0 ] && text_lacks "$shots_out" '^not ok - '; then fail "screenshot run exited $shots_rc"; fi
fi

echo "# phase 2: clean stop, restart, persistence"
stop_cleanly "first boot"
check "the log shows the add-on's own shutdown" log_has "openGym: stopping."
docker start "$ADDON" >/dev/null
wait_ready "restart"
client_phase restart
check "after restart: /data/opengym/secret is unchanged" [ "$(in_addon sha256sum /data/opengym/secret | cut -d' ' -f1)" = "$SECRET_SUM" ]
check "after restart: the integration token file is unchanged" [ "$(in_addon cat /data/gateway/integration_token)" = "$TOKEN" ]

echo "# phase 3: restarted with external_url set (direct access on)"
stop_cleanly "restarted"
put_options options-external-url.json
docker start "$ADDON" >/dev/null
wait_ready "external_url"
check "the log says direct access is on for the external_url origin" \
  log_has "openGym: direct access on port 8099 is ON for https://gym.example.test (external_url)."
client_phase external-url

echo "# phase 4: a stop during boot"
stop_cleanly "external_url"
since=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
docker start "$ADDON" >/dev/null
# TERM only once the entrypoint has installed its early trap (it logs "starting." right after):
# before that, PID 1 has no handler and the kernel drops the signal, which is the pre-trap
# window this phase is not about.
for _ in $(seq 1 200); do
  if text_contains "$(docker logs --since "$since" "$ADDON" 2>&1)" ') starting\.$'; then break; fi
  sleep 0.05
done
stop_cleanly "stop during boot"
boot_log=$(docker logs --since "$since" "$ADDON" 2>&1)
printf '%s\n' "$boot_log" >"$OUT/boot-stop.txt"
check "the TERM arrived during boot (the gateway never started)" text_lacks "$boot_log" 'gateway on port 8099'
check "the entrypoint handled it (stop requested during startup / stopping.)" \
  text_contains "$boot_log" 'stop requested during startup|openGym: stopping\.'

echo "# e2e: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
