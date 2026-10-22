#!/bin/sh
# Tests for opengym/rootfs/usr/local/bin/opengym-install-integration.sh (install_integration).
# Busybox sh, like the add-on. Run it in a throwaway container from an empty writable /w, as
# root (one case drops to `nobody`):
#
#   docker run --rm -v "$PWD:/repo:ro" --tmpfs /w:exec --workdir=/w node:22-alpine \
#     sh /repo/tests/installer/test-installer.sh
#
# Every path it writes is relative to /w. Prints one ok / not ok line per case; exit 1 if any
# failed.
#
# shellcheck disable=SC2016 # all() evaluates its single-quoted conditions after each run
set -u
INSTALLER=$(cd "$(dirname "$0")/../.." && pwd)/opengym/rootfs/usr/local/bin/opengym-install-integration.sh
if [ ! -f "$INSTALLER" ]; then echo "not ok - installer not found at $INSTALLER"; exit 1; fi
cd /w || exit 1
MARK=.installed-by-opengym-addon
CC=ha/custom_components
fail=0
out=""
rc=0

# expect "<case>" <command...>: one case, passed when the command succeeds.
expect() {
  name=$1
  shift
  if "$@"; then printf 'ok - %s\n' "$name"; else printf 'not ok - %s (output: %s)\n' "$name" "$out"; fail=1; fi
}
says() { printf '%s\n' "$out" | grep -q -- "$1"; }
never_says() { ! says "$1"; }
installed() { head -n 1 "$CC/opengym/$MARK" 2>/dev/null; }
is_installed() { [ "$(installed)" = "$1" ]; }
# Entries of custom_components other than opengym (temp dirs left behind would show here).
others() {
  for e in "$CC"/* "$CC"/.[!.]*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    [ "${e##*/}" = opengym ] || printf '%s\n' "${e##*/}"
  done
}
no_others() { [ -z "$(others)" ]; }
empty_dir() { [ -d "$1" ] && [ -z "$(ls -A "$1")" ]; }
all() { for c in "$@"; do eval "$c" || return 1; done; }

mk_src() {
  rm -rf src
  mkdir -p src/opengym/translations
  printf '{\n  "domain": "opengym",\n  "version": "%s"\n}\n' "$1" > src/opengym/manifest.json
  echo code > src/opengym/__init__.py
  echo '{}' > src/opengym/translations/en.json
}
# The installer's output in $out; any exit status but 0 is a failure of its own.
run() {
  # timeout: a regression that blocks on a planted FIFO fails instead of hanging the run.
  out=$(OPENGYM_INTEGRATION_SRC=src/opengym OPENGYM_HA_CONFIG=ha timeout 20 sh "$INSTALLER" 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then printf 'not ok - exit status %s, must always be 0 (output: %s)\n' "$rc" "$out"; fail=1; fi
}
reset() {
  chmod -R u+w ha 2>/dev/null
  rm -rf ha elsewhere
  mkdir -p ha
}
same_as_bundle() {
  [ "$(diff -r src/opengym "$CC/opengym" 2>&1)" = "Only in $CC/opengym: $MARK" ]
}

reset; mk_src 0.1.0; run
expect "fresh install, subfolders too" \
  all 'is_installed 0.1.0' '[ -f "$CC/opengym/__init__.py" ]' '[ -f "$CC/opengym/translations/en.json" ]'
expect "fresh install says restart" says "installed the openGym integration 0.1.0. Restart Home Assistant"
expect "one log line" [ "$(printf '%s\n' "$out" | wc -l)" -eq 1 ]
expect "the copy is the bundle plus the marker" same_as_bundle
run
expect "same version is a no-op" says "version 0.1.0 is already installed"
mk_src 0.2.0; run
expect "upgrade of its own copy" all 'is_installed 0.2.0' 'says "from 0.1.0 to 0.2.0"' same_as_bundle
expect "no temp dirs left" no_others

reset; mk_src 0.2.0; mkdir -p "$CC/.opengym-addon-new" "$CC/.opengym-addon-old"; run
expect "leftovers of a start that died halfway are cleared" all 'is_installed 0.2.0' no_others

reset; mkdir -p "$CC/opengym"; echo hacs > "$CC/opengym/__init__.py"; run
expect "HACS copy untouched" \
  all '[ "$(cat "$CC/opengym/__init__.py")" = hacs ]' '[ ! -e "$CC/opengym/$MARK" ]' 'says "installed another way"'
reset; mkdir -p "$CC"; echo file > "$CC/opengym"; run
expect "a file in its place is untouched" [ "$(cat "$CC/opengym")" = file ]

reset; mkdir -p elsewhere; ln -s ../elsewhere "$CC"; run
expect "symlinked custom_components not followed" all 'empty_dir elsewhere' 'says "symbolic link"'
reset; mkdir -p "$CC" elsewhere; ln -s ../../elsewhere "$CC/opengym"; run
expect "symlinked opengym not followed" all 'empty_dir elsewhere' 'says "symbolic link"'
reset; mk_src 0.2.0; mkdir -p "$CC/opengym"; echo "db_password: hunter2" > ha/secrets.yaml
ln -s ../../secrets.yaml "$CC/opengym/$MARK"; run
expect "symlinked marker not followed, its target never logged" \
  all 'says "symbolic link"' 'never_says hunter2' '[ ! -e "$CC/opengym/__init__.py" ]'
reset; mk_src 0.2.0; mkdir -p "$CC/opengym"; echo "db_password: hunter2" > "$CC/opengym/$MARK"; run
expect "a marker without the add-on's fingerprint: untouched, its content never logged" \
  all 'says "changed since the add-on installed it"' 'never_says hunter2' '[ ! -e "$CC/opengym/__init__.py" ]'

# HACS (or a person) changed the add-on's copy without removing the marker.
reset; mk_src 0.1.0; run
sed -i 's/"version": "0.1.0"/"version": "0.1.5"/' "$CC/opengym/manifest.json"
mk_src 0.2.0; run
expect "a copy whose manifest changed since it was installed: untouched" \
  all 'says "changed since the add-on installed it"' 'grep -q 0.1.5 "$CC/opengym/manifest.json"'
reset; mk_src 0.1.0; run
# shellcheck disable=SC2034 # read by all() through eval
pinned=$(sed -n 2p "$CC/opengym/$MARK")
# shellcheck disable=SC2034 # read by all() through eval
actual=$(sha256sum "$CC/opengym/manifest.json" | cut -d' ' -f1)
expect "the marker's second line is the installed manifest.json's sha256" all '[ -n "$pinned" ]' '[ "$pinned" = "$actual" ]'
# A FIFO in its place must not even be opened: that blocks until a writer comes. A writer
# arrives after 8 s, so a regression shows up as a slow run, not as a hung one.
rm "$CC/opengym/manifest.json"; mkfifo "$CC/opengym/manifest.json"; mk_src 0.2.0
(sleep 8; : > "$CC/opengym/manifest.json") & writer=$!
started=$(date +%s); run; took=$(( $(date +%s) - started ))
kill "$writer" 2>/dev/null; wait "$writer" 2>/dev/null
expect "manifest.json replaced by a FIFO: untouched, never opened (took ${took}s)" \
  all 'says "changed since the add-on installed it"' '[ -p "$CC/opengym/manifest.json" ]' '[ "$took" -lt 5 ]'
reset; mk_src 0.1.0; run
mv "$CC/opengym/manifest.json" ha/real-manifest.json; ln -s ../../real-manifest.json "$CC/opengym/manifest.json"; mk_src 0.2.0; run
expect "a symlinked manifest.json: untouched" \
  all 'says "changed since the add-on installed it"' '[ -L "$CC/opengym/manifest.json" ]'

rm -rf ha; run
expect "no config folder: skip" says "not mounted"
reset; rm -f src/opengym/manifest.json; run
expect "bundle without a version: skip" all 'says "no readable version"' '[ ! -e "$CC" ]'

reset; mk_src 0.1.0; chmod 0555 ha; chmod -R a+rX src; chmod 0777 .
out=$(su nobody -s /bin/sh -c "cd /w && OPENGYM_INTEGRATION_SRC=src/opengym OPENGYM_HA_CONFIG=ha sh '$INSTALLER'" 2>&1); rc=$?
expect "unwritable: skip, exit 0" all '[ "$rc" -eq 0 ]' 'says "could not write"' '[ ! -e "$CC" ]'
exit $fail
