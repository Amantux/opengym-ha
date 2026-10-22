#!/usr/bin/env bash
# End-to-end test of the openGym add-on image behind a fake Home Assistant ingress.
#
#   bash tests/e2e/run.sh                       (builds the image first)
#   sudo E2E_APPARMOR=1 bash tests/e2e/run.sh   (CI's smoke job: the same, under AppArmor)
#
# It builds the add-on the way the Supervisor does (the Dockerfile's pinned upstream images,
# the Supervisor's build args), then on a throwaway Docker network with the hassio subnet
# 172.30.32.0/23:
#   172.30.32.2   fake ingress (nginx): the ONE address the gateway trusts for HA identity
#   172.30.32.3   assertion client (node): any other container on the network
#   172.30.32.4   browser (Playwright), only with E2E_SCREENSHOT_DIR
#   172.30.32.5   Supervisor stub (node, DNS name `supervisor`), last phase only
#   172.30.33.10  the add-on, /data on a fresh volume holding options.json, and a fake Home
#                 Assistant configuration folder (a second volume: secrets.yaml and an empty
#                 custom_components/) at /homeassistant, as config.yaml's `map` mounts it
# and checks ingress sign-in, framing, the direct-access gate, the integration API and its
# body-weight write, process privileges, clean stops, persistence across a restart, the
# external_url mode, a stop during boot, discovery under a Supervisor token (root, never
# readable by uid 1000), and install_integration: off never touches the configuration folder;
# on installs the bundled integration, a restart changes nothing, and a copy that HACS or a
# person put there is never touched. Every container, the network and the volumes are
# removed on exit, pass or fail; logs go to $E2E_OUT first. Exit status 1 if any check failed.
#
# With E2E_APPARMOR=1 every add-on container runs confined by opengym/apparmor.txt, the way
# the Supervisor runs it, and the suite also checks the fence: which profile each process is
# in (read from the host's /proc), and that no node or nginx process, as app or as root, nor
# anything they start, can read, list or write /homeassistant. It needs root and
# apparmor_parser; it loads the profile and unloads it again on exit unless it was already
# loaded.
#
# Environment (all optional):
#   E2E_IMAGE            image tag to build/test           (opengym-ha:e2e)
#   E2E_BUILD            1 = build E2E_IMAGE first, 0 = use it as it is   (1)
#   E2E_PREFIX           prefix for container/network/volume names        (opengym-e2e)
#   E2E_OUT              where logs are written            (tests/e2e/out)
#   E2E_NODE_IMAGE       assertion client image            (node:22-alpine)
#   E2E_NGINX_IMAGE      fake ingress image                (nginx:alpine)
#   E2E_SCREENSHOT_DIR   if set: Playwright screenshots through the ingress are saved here,
#                        with browser-log.json (console, failed and 4xx/5xx requests)
#   E2E_PLAYWRIGHT_IMAGE image with node + the playwright module + Chromium (required with
#                        E2E_SCREENSHOT_DIR; see screenshot.mjs for how it is located)
#   E2E_APPARMOR         1 = run the add-on under opengym/apparmor.txt (root only)     (0)
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
APPARMOR=${E2E_APPARMOR:-0}
PROFILE_FILE=$REPO/opengym/apparmor.txt

NET=$PREFIX-net
VOL=$PREFIX-data
HAVOL=$PREFIX-ha
ADDON=$PREFIX-addon
INGRESS=$PREFIX-ingress
CLIENT=$PREFIX-client
BROWSER=$PREFIX-browser
SEED=$PREFIX-seed
SUPERVISOR=$PREFIX-supervisor
SUBNET=172.30.32.0/23
INGRESS_IP=172.30.32.2
CLIENT_IP=172.30.32.3
BROWSER_IP=172.30.32.4
SUPERVISOR_IP=172.30.32.5
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
  docker rm -f "$BROWSER" "$CLIENT" "$INGRESS" "$ADDON" "$SEED" "$SUPERVISOR" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$VOL" "$HAVOL" >/dev/null 2>&1 || true
}

# AppArmor (E2E_APPARMOR=1): the profile's name, whether this run loaded it, and the option
# every add-on container is started with.
PROFILE=""
PROFILE_LOADED_HERE=0
SEC=()

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  mkdir -p "$OUT"
  docker logs "$ADDON" >"$OUT/addon.log" 2>&1 || true
  docker logs "$INGRESS" >"$OUT/fake-ingress.log" 2>&1 || true
  docker logs "$SUPERVISOR" >"$OUT/supervisor-stub.log" 2>&1 || true
  remove_all
  if [ "$PROFILE_LOADED_HERE" = 1 ]; then
    apparmor_parser -R "$PROFILE_FILE" >/dev/null 2>&1 || echo "e2e: could not unload AppArmor profile $PROFILE" >&2
  fi
  if [ "$status" -ne 0 ]; then echo "e2e: logs in $OUT" >&2; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$OUT"
: >"$OUT/client.txt"
if [ -n "$SHOTS" ] && [ -z "$PW_IMAGE" ]; then die "E2E_SCREENSHOT_DIR needs E2E_PLAYWRIGHT_IMAGE"; fi

# ---------------------------------------------------------------------------------------
# AppArmor: load opengym/apparmor.txt the way the Supervisor does (it names the profile after
# the one line that starts with `profile`, and refuses a file with none or several, see
# supervisor/utils/apparmor.py), and confine every add-on container with it.
# ---------------------------------------------------------------------------------------
if [ "$APPARMOR" = 1 ]; then
  [ "$(id -u)" = 0 ] || die "E2E_APPARMOR=1 needs root: it loads $PROFILE_FILE and reads the add-on's labels in the host's /proc"
  command -v apparmor_parser >/dev/null || die "E2E_APPARMOR=1 needs apparmor_parser"
  [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = Y ] || die "E2E_APPARMOR=1: AppArmor is not enabled in this kernel"
  names=$(sed -n 's/^profile \([^ ]*\).*/\1/p' "$PROFILE_FILE")
  [ "$(grep -c . <<<"$names")" = 1 ] || die "$PROFILE_FILE needs exactly one line starting with 'profile', as the Supervisor requires (found: ${names:-none})"
  PROFILE=$names
  if ! grep -q "^$PROFILE (" /sys/kernel/security/apparmor/profiles; then PROFILE_LOADED_HERE=1; fi
  apparmor_parser -r "$PROFILE_FILE" || die "apparmor_parser could not load $PROFILE_FILE"
  SEC=(--security-opt "apparmor=$PROFILE")
  echo "e2e: AppArmor profile $PROFILE loaded; every add-on container runs confined by it"
fi

# ---------------------------------------------------------------------------------------
# Build like the Supervisor: BUILD_VERSION (config.yaml's version) and BUILD_ARCH, which every
# Supervisor passes, and the BUILD_FROM a Supervisor older than 2026.04 passes when there is no
# build.yaml: Home Assistant's own base image. The Dockerfile must leave it unused (it names
# the upstream api image in its FROM line), so a build that honoured it fails this suite.
# ---------------------------------------------------------------------------------------
VERSION=$(sed -n 's/^version: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' "$REPO/opengym/config.yaml")
[ -n "$VERSION" ] || die "no version in opengym/config.yaml"
if [ "$BUILD" = 1 ]; then
  case "$(uname -m)" in
    x86_64) ARCH=amd64 ;;
    aarch64 | arm64) ARCH=aarch64 ;;
    *) die "unsupported machine $(uname -m)" ;;
  esac
  echo "e2e: building $IMAGE ($ARCH, $VERSION)"
  if ! docker build --build-arg "BUILD_FROM=ghcr.io/home-assistant/$ARCH-base:latest" \
    --build-arg "BUILD_VERSION=$VERSION" \
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
# A shell on the fake Home Assistant configuration folder (mounted at /ha), outside the add-on.
ha_sh() {
  docker run --rm -i --name "$SEED" -v "$HAVOL:/ha" --entrypoint sh "$IMAGE" -c "$1"
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
count_role() { awk -v r="$2" '$7 == r' <<<"$1" | wc -l; }
# The servers (api, gateway, nginx master and workers) all run as uid 1000, all four Uid fields.
servers_run_as_app() {
  [ -z "$(awk '($7 == "api" || $7 == "gateway" || $7 == "nginx") && !($3 == 1000 && $4 == 1000 && $5 == 1000 && $6 == 1000)' <<<"$1")" ]
}
exit_code() { docker inspect -f '{{.State.ExitCode}}' "$ADDON"; }
# Role and AppArmor label of every process in the add-on, one "<role> <label>" line each. The
# label is read from the HOST's /proc (docker top prints host pids), outside any profile.
addon_labels() {
  local pid args role
  docker top "$ADDON" -eo pid,args | tail -n +2 | while read -r pid args; do
    case "$args" in
      'node server.js') role=api ;;
      'node /opt/gateway/src/server.js') role=gateway ;;
      'node /opt/gateway/src/cli.js discovery') role=discovery ;;
      'nginx: '*) role=nginx ;;
      '/bin/sh /usr/local/bin/opengym-entrypoint.sh') role=entrypoint ;;
      *) role=other ;;
    esac
    echo "$role $(cat "/proc/$pid/attr/current" 2>/dev/null || echo unreadable)"
  done
}
# all_in_label <labels> <role> <label>: the role runs, and every process of it has that label.
all_in_label() {
  local n bad
  n=$(awk -v r="$2" '$1 == r' <<<"$1" | wc -l)
  bad=$(awk -v r="$2" -v l="$3" '$1 == r && substr($0, length(r) + 2) != l' <<<"$1" | wc -l)
  [ "$n" -ge 1 ] && [ "$bad" -eq 0 ]
}
# node -e "$FS_PROBE" <read|list|write|cat> <path>: one file operation, printing OK or the error
# code (cat: /bin/cat started by node, EACCES when it reports "Permission denied").
FS_PROBE='const fs = require("fs"); const [op, p] = process.argv.slice(1);
try {
  if (op === "read") fs.readFileSync(p);
  else if (op === "list") fs.readdirSync(p);
  else if (op === "write") fs.writeFileSync(p, "fence probe\n");
  else require("child_process").execFileSync("/bin/cat", [p], { stdio: "pipe" });
  console.log("OK");
} catch (e) {
  console.log(e.code || (/Permission denied/.test(String(e.stderr)) ? "EACCES" : "ERROR"));
}'
# The fence (E2E_APPARMOR=1): node and nginx, as app and as root, and what node starts, never
# reach /homeassistant, while the entrypoint's profile (the installer's) does. A bare
# `docker exec <c> node` would NOT show this: docker exec puts the binary it starts into the
# container's profile directly, without the exec transition. Nothing in the add-on starts node
# that way; the entrypoint starts it from a shell or gosu, so the root probes go through env.
fence_checks() {
  local app=$PROFILE//app
  check "fence: as app, node cannot read /homeassistant/secrets.yaml" \
    [ "$(docker exec "$ADDON" gosu app node -e "$FS_PROBE" read /homeassistant/secrets.yaml)" = EACCES ]
  check "fence: as root, node cannot read /homeassistant/secrets.yaml" \
    [ "$(docker exec "$ADDON" env node -e "$FS_PROBE" read /homeassistant/secrets.yaml)" = EACCES ]
  check "fence: as root, node cannot list /homeassistant" \
    [ "$(docker exec "$ADDON" env node -e "$FS_PROBE" list /homeassistant)" = EACCES ]
  check "fence: as root, node cannot write into /homeassistant/custom_components" \
    [ "$(docker exec "$ADDON" env node -e "$FS_PROBE" write /homeassistant/custom_components/fence-probe)" = EACCES ]
  check "fence: a program node starts (/bin/cat, as root) cannot read secrets.yaml either" \
    [ "$(docker exec "$ADDON" env node -e "$FS_PROBE" cat /homeassistant/secrets.yaml)" = EACCES ]
  local ngx
  ngx=$(docker exec "$ADDON" gosu app nginx -t -c /homeassistant/secrets.yaml 2>&1 || true)
  check "fence: nginx (as app) cannot open /homeassistant/secrets.yaml" \
    text_contains "$ngx" 'open\(\) "/homeassistant/secrets.yaml" failed \(13: Permission denied\)'
  check "fence: nothing was written into custom_components" [ -z "$(ha_sh 'ls -A /ha/custom_components')" ]
  # Not vacuous: outside the child profile the same file IS readable, also as app, so the
  # denials above come from the profile, not from file permissions.
  check "fence: outside the child profile secrets.yaml is readable as root (docker exec cat)" \
    [ "$(in_addon cat /homeassistant/secrets.yaml)" = "$HA_SECRET" ]
  check "fence: outside the child profile secrets.yaml is readable as app (docker exec -u app cat)" \
    [ "$(docker exec -u app "$ADDON" cat /homeassistant/secrets.yaml)" = "$HA_SECRET" ]
  # The child cannot reach into a uid-1000 process of the parent profile either (no ptrace
  # across profiles), so it cannot borrow one that may touch /homeassistant.
  docker exec -d -u app "$ADDON" sleep 60
  local helper="" res=""
  for _ in $(seq 1 20); do
    helper=$(in_addon sh -c "$APP_SLEEP_SH" | head -n 1) || true
    [ -n "$helper" ] && break
    sleep 0.1
  done
  if [ -n "$helper" ]; then
    res=$(docker exec -u app "$ADDON" env node -e 'try { require("fs").readFileSync(`/proc/${process.argv[1]}/environ`); console.log("OK"); } catch (e) { console.log(e.code); }' "$helper")
    in_addon kill "$helper" 2>/dev/null || true
  fi
  check "fence: node (as app) cannot read the environment of an app process in $PROFILE (got ${res:-no helper})" \
    [ "$res" = EACCES ]
  local labels
  labels=$(addon_labels)
  printf '%s\n' "$labels" >"$OUT/apparmor-labels.txt"
  check "AppArmor: the entrypoint (PID 1) runs in $PROFILE (enforce)" all_in_label "$labels" entrypoint "$PROFILE (enforce)"
  check "AppArmor: the api runs in $app (enforce)" all_in_label "$labels" api "$app (enforce)"
  check "AppArmor: the gateway runs in $app (enforce)" all_in_label "$labels" gateway "$app (enforce)"
  check "AppArmor: nginx (master and worker) runs in $app (enforce)" all_in_label "$labels" nginx "$app (enforce)"
}
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
# pid, comm, the four Uid fields and the role of every process in the add-on. The role comes
# from the EXACT command line (a substring match would find the scanning shell's own script),
# nginx's from its comm (it rewrites its command line): api, gateway, discovery, nginx, other.
PROCS_SH=$(cat <<'EOF'
for d in /proc/[0-9]*; do
  c=$(cat "$d/comm" 2>/dev/null) || continue
  u=$(sed -n 's/^Uid:[[:space:]]*//p' "$d/status" 2>/dev/null) || continue
  a=$(tr '\0' ' ' 2>/dev/null <"$d/cmdline") || continue
  case "$a" in
    'node server.js ') r=api ;;
    'node /opt/gateway/src/server.js ') r=gateway ;;
    'node /opt/gateway/src/cli.js discovery ') r=discovery ;;
    *) if [ "$c" = nginx ]; then r=nginx; else r=other; fi ;;
  esac
  [ -n "$u" ] && echo "${d#/proc/} $c $u $r"
done
EOF
)
# The pid of a `sleep` running as uid 1000 (fence_checks starts one with docker exec -u app).
APP_SLEEP_SH=$(cat <<'EOF'
for d in /proc/[0-9]*; do
  [ "$(cat "$d/comm" 2>/dev/null)" = sleep ] || continue
  if grep -q '^Uid:[[:space:]]*1000[[:space:]]' "$d/status" 2>/dev/null; then echo "${d#/proc/}"; fi
done
EOF
)
# Run AS app (what the api could do): "<n> <pid:comm>...", the number of other processes whose
# environment it can read, then each one whose environment holds SUPERVISOR_TOKEN.
ENVIRON_SH=$(cat <<'EOF'
n=0
holders=""
for d in /proc/[0-9]*; do
  [ "${d#/proc/}" = "$$" ] && continue
  e=$(tr '\0' '\n' 2>/dev/null <"$d/environ") || continue
  n=$((n + 1))
  if printf '%s\n' "$e" | grep -q '^SUPERVISOR_TOKEN='; then
    holders="$holders ${d#/proc/}:$(cat "$d/comm" 2>/dev/null)"
  fi
done
echo "$n$holders"
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
docker volume create "$HAVOL" >/dev/null
HA_SECRET="e2e_secret: $(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$HA_SECRET" | ha_sh 'mkdir -p /ha/custom_components && cat > /ha/secrets.yaml && chmod 0644 /ha/secrets.yaml'

docker run -d --name "$INGRESS" --network "$NET" --ip "$INGRESS_IP" \
  -v "$HERE/fixtures/fake-ingress.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$HERE/fixtures/fake-ingress-proxy.inc:/etc/nginx/fake-ha-proxy.inc:ro" \
  -v "$HERE/fixtures/panel.html:/usr/share/nginx/fake-ha/panel.html:ro" \
  "$NGINX_IMAGE" >/dev/null
docker run -d --name "$CLIENT" --network "$NET" --ip "$CLIENT_IP" -v "$HERE:/e2e:ro" \
  "$NODE_IMAGE" sleep infinity >/dev/null
# The image's own HEALTHCHECK command, polled every 2 s instead of every minute.
docker run -d --name "$ADDON" --network "$NET" --ip "$ADDON_IP" -v "$VOL:/data" \
  -v "$HAVOL:/homeassistant" "${SEC[@]}" \
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
check "the api (node server.js) is running, once" [ "$(count_role "$procs" api)" -eq 1 ]
check "the gateway (node /opt/gateway/src/server.js) is running, once" [ "$(count_role "$procs" gateway)" -eq 1 ]
check "nginx (master and worker) is running" [ "$(count_role "$procs" nginx)" -ge 2 ]
check "every server (api, gateway, nginx) runs as uid 1000 (real, effective, saved, fs)" \
  servers_run_as_app "$procs"
SECRET_SUM=$(in_addon sha256sum /data/opengym/secret | cut -d' ' -f1)
if [ "$APPARMOR" = 1 ]; then
  echo "# the AppArmor fence around /homeassistant"
  fence_checks
fi

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

echo "# phase 5: under a (stub) Supervisor: discovery runs as root and announces the token"
# A Supervisor token only reaches a container at creation, so this is a new add-on container
# on the same volume. The stub holds its answer to GET /addons/self/info for 8 s, so the
# discovery process is alive, holding the token, while its privileges are inspected.
SV_TOKEN=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
stub_log() { docker logs "$SUPERVISOR" 2>&1; }
# stub_has <exact line> <seconds>: wait for the stub to print that line (one request each).
stub_has() {
  local l
  for _ in $(seq 1 $(($2 * 4))); do
    l=$(stub_log)
    if grep -qxF -- "$1" <<<"$l"; then return 0; fi
    sleep 0.25
  done
  return 1
}
docker rm -f "$ADDON" >/dev/null
put_options options-default.json
docker run -d --name "$SUPERVISOR" --network "$NET" --ip "$SUPERVISOR_IP" --network-alias supervisor \
  -e HOLD_MS=8000 -v "$HERE:/e2e:ro" "$NODE_IMAGE" node /e2e/supervisor-stub.mjs >/dev/null
stub_has "supervisor stub listening on :80" 20 || die "the Supervisor stub did not start; see $OUT/supervisor-stub.log"
docker run -d --name "$ADDON" --network "$NET" --ip "$ADDON_IP" -v "$VOL:/data" \
  -v "$HAVOL:/homeassistant" "${SEC[@]}" -e SUPERVISOR_TOKEN="$SV_TOKEN" "$IMAGE" >/dev/null
wait_ready "under the Supervisor"
check "discovery asked the Supervisor for this add-on's hostname, with Bearer <Supervisor token>" \
  stub_has "{\"method\":\"GET\",\"url\":\"/addons/self/info\",\"auth\":\"Bearer $SV_TOKEN\",\"body\":null}" 90
# Discovery is now waiting for the held answer.
procs=$(in_addon sh -c "$PROCS_SH")
printf '%s\n' "$procs" >"$OUT/processes-supervisor.txt"
if [ "$APPARMOR" = 1 ]; then
  check "AppArmor: discovery (root) runs in $PROFILE//app (enforce) too" \
    all_in_label "$(addon_labels)" discovery "$PROFILE//app (enforce)"
fi
# The scanner must not carry the token itself: docker exec hands it the container's -e values.
# It runs as the api would: as app, started by node (under AppArmor that is the servers' child
# profile, whose processes can read each other's /proc; env first, see fence_checks).
seen=$(docker exec -u app "$ADDON" env -u SUPERVISOR_TOKEN node -e \
  'process.stdout.write(require("child_process").execFileSync("/bin/sh", ["-c", process.argv[1]]))' "$ENVIRON_SH")
printf '%s\n' "$seen" >"$OUT/environ-scan.txt"
readable=${seen%% *}
check "discovery is running while it waits for the Supervisor" [ "$(count_role "$procs" discovery)" -eq 1 ]
check "discovery runs as root (real, effective, saved, fs uid 0), not as app" \
  [ -z "$(awk '$7 == "discovery" && !($3 == 0 && $4 == 0 && $5 == 0 && $6 == 0)' <<<"$procs")" ]
check "every server (api, gateway, nginx) still runs as uid 1000" servers_run_as_app "$procs"
check "as app, the environments of the other app processes are readable (got $readable)" [ "$readable" -ge 3 ]
check "no environment app can read holds SUPERVISOR_TOKEN (holders:${seen#"$readable"})" [ "$seen" = "$readable" ]
check "the discovery state dir is root's alone (0700 root)" \
  [ "$(in_addon stat -c '%a %u' /run/opengym-discovery)" = "700 0" ]
check "discovery POSTed {service opengym, host local-opengym, port 8099, the integration token}" \
  stub_has "{\"method\":\"POST\",\"url\":\"/discovery\",\"auth\":\"Bearer $SV_TOKEN\",\"body\":{\"service\":\"opengym\",\"config\":{\"host\":\"local-opengym\",\"port\":8099,\"token\":\"$TOKEN\"}}}" 30
check "the log says discovery announced local-opengym:8099" \
  log_has "openGym discovery: announced local-opengym:8099 to Home Assistant"
check "the Supervisor token never appears in the log" log_lacks "$SV_TOKEN"
check "install_integration off: the log says nothing about the integration installer" \
  log_lacks "integration installer"
check "install_integration off: Home Assistant's custom_components is untouched (still empty)" \
  [ -z "$(ha_sh 'ls -A /ha/custom_components')" ]
check "install_integration off: secrets.yaml is unchanged" [ "$(ha_sh 'cat /ha/secrets.yaml')" = "$HA_SECRET" ]
stop_cleanly "under the Supervisor"

echo "# phase 6: install_integration on: the bundled integration goes into custom_components"
# A fresh container on the same volumes, as after changing the option and restarting.
INSTALLER_SAYS="openGym: integration installer:"
MARK=/ha/custom_components/opengym/.installed-by-opengym-addon
log_since() { docker logs --since "$1" "$ADDON" 2>&1; }
docker rm -f "$ADDON" >/dev/null
put_options options-install-integration.json
docker run -d --name "$ADDON" --network "$NET" --ip "$ADDON_IP" -v "$VOL:/data" \
  -v "$HAVOL:/homeassistant" "${SEC[@]}" "$IMAGE" >/dev/null
wait_ready "install_integration"
check "the log says the integration was installed, and to restart Home Assistant" \
  log_has "$INSTALLER_SAYS installed the openGym integration $VERSION. Restart Home Assistant (Settings > System > Restart) to load it; openGym then shows up under Settings > Devices & services."
copy_diff=$(in_addon diff -r /opt/opengym/integration/opengym /homeassistant/custom_components/opengym 2>&1 || true)
check "custom_components/opengym is the image's bundled integration, file for file, plus the marker" \
  [ "$copy_diff" = "Only in /homeassistant/custom_components/opengym: .installed-by-opengym-addon" ]
check "the marker names this add-on version ($VERSION)" [ "$(ha_sh "cat $MARK")" = "$VERSION" ]
check "nothing else was left in custom_components (no temp dirs)" [ "$(ha_sh 'ls -A /ha/custom_components')" = opengym ]
check "secrets.yaml is unchanged" [ "$(ha_sh 'cat /ha/secrets.yaml')" = "$HA_SECRET" ]
client_phase restart
if [ "$APPARMOR" = 1 ]; then
  check "fence: with install_integration on, node (as app) still cannot read the installed copy" \
    [ "$(docker exec "$ADDON" gosu app node -e "$FS_PROBE" read /homeassistant/custom_components/opengym/manifest.json)" = EACCES ]
fi
stamp_before=$(ha_sh "stat -c '%i %Y' $MARK /ha/custom_components/opengym/manifest.json")

stop_cleanly "install_integration"
since=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
docker start "$ADDON" >/dev/null
wait_ready "install_integration, restarted"
check "restarted: the log says this version is already installed" \
  text_contains "$(log_since "$since")" "^$INSTALLER_SAYS version $VERSION is already installed\.$"
check "restarted: the installed copy was not rewritten (same inodes and times)" \
  [ "$(ha_sh "stat -c '%i %Y' $MARK /ha/custom_components/opengym/manifest.json")" = "$stamp_before" ]

# A copy that HACS (or a person) put there carries no marker: it is never touched.
stop_cleanly "install_integration, restarted"
ha_sh 'cd /ha/custom_components && rm -rf opengym && mkdir opengym && echo "# installed by HACS" > opengym/__init__.py'
since=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
docker start "$ADDON" >/dev/null
wait_ready "install_integration over a HACS copy"
check "over a copy without the marker: the log says it was installed another way and not touched" \
  text_contains "$(log_since "$since")" "^$INSTALLER_SAYS custom_components/opengym was installed another way \(HACS or by hand\); not touched\.$"
check "over a copy without the marker: that copy is exactly as it was" \
  [ "$(ha_sh 'cd /ha/custom_components/opengym && ls -A && cat __init__.py')" = "$(printf '__init__.py\n# installed by HACS')" ]
stop_cleanly "install_integration over a HACS copy"

echo "# e2e: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
