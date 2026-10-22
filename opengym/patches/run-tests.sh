#!/bin/sh
# Checks 0001-ha-internal-listener.patch against an upstream openGym checkout, the way the add-on
# build uses it: the patch must apply to api/server.js with no fuzz, upstream's own api suite must
# show no failure the patch caused, and our tests (test/*.test.mjs) must pass. Everything runs
# inside node:22-alpine, the base of upstream's api image and the image upstream's own CI uses.
#
#   usage: run-tests.sh <path-to-upstream-checkout>    (a clone of openGym at the pinned tag)
#
# The checkout is mounted read-only and never changed; the patched copy lives in the container.
set -eu

IMAGE=node:22-alpine
PATCH=0001-ha-internal-listener.patch

if [ "${1:-}" = --in-container ]; then
  # GNU patch: alpine's busybox has no patch applet at all, and --fuzz=0 is the point here.
  apk add --no-cache --quiet patch

  # api/ is copied, because it gets patched. Every other top-level entry is linked instead:
  # upstream's api tests read beyond api/ (../../frontend/src/lib, web/, helm/, kubernetes/,
  # scripts/), exactly as they do when upstream's CI runs them from the repository root.
  work=$(mktemp -d)
  for entry in /upstream/* /upstream/.[!.]*; do
    [ -e "$entry" ] || continue
    name=${entry##*/}
    case $name in api | .git) continue ;; esac
    ln -s "$entry" "$work/$name"
  done
  mkdir "$work/api"
  tar -C /upstream/api --exclude=./node_modules -cf - . | tar -C "$work/api" -xf -
  cd "$work/api"

  # -N: a patch that looks already applied (or reversed) is refused, never silently reversed.
  apply() { patch -p1 --fuzz=0 -N --no-backup-if-mismatch -d "$work/api" -i "/patches/$PATCH" "$@" </dev/null; }
  echo "== $PATCH: dry run, then apply (patch -p1 --fuzz=0)"
  if ! apply --dry-run; then
    echo "FAIL: $PATCH does not apply cleanly to this checkout's api/server.js" >&2
    exit 1
  fi
  apply

  # The same install as upstream's CI job (test:api in .gitlab-ci.yml): no Agent SDK.
  npm ci --omit=optional --no-audit --no-fund

  # The names of the top-level tests that failed, from npm test's TAP output, one per line.
  failed() { sed -n 's/^not ok [0-9]* - //p' "$1" | LC_ALL=C sort; }

  echo "== upstream api suite (npm test) on the patched tree"
  if npm test >"$work/patched.tap" 2>&1; then
    tail -n 8 "$work/patched.tap"
  else
    tail -n 8 "$work/patched.tap"
    # Upstream's suite can fail with no help from us: v1.4.1's is dated. Its Coach fixtures hold
    # training logged in July 2026 and the review reads the weeks before *now*, so from about two
    # weeks after it shipped ten tests fail on an untouched checkout. So a failure is compared with
    # the same suite on the same tree unpatched, and the patch passes only if it adds none.
    echo "== upstream api suite failed; running it again on the unpatched tree to compare"
    apply -R
    npm test >"$work/pristine.tap" 2>&1 || true
    apply
    failed "$work/patched.tap" >"$work/patched.failed"
    failed "$work/pristine.tap" >"$work/pristine.failed"
    if [ ! -s "$work/patched.failed" ]; then
      echo "FAIL: npm test failed on the patched tree, but no test is marked failed (output above)" >&2
      exit 1
    fi
    ours=$(LC_ALL=C comm -23 "$work/patched.failed" "$work/pristine.failed")
    if [ -n "$ours" ]; then
      echo "FAIL: these upstream tests fail only with the patch applied:" >&2
      printf '%s\n' "$ours" >&2
      exit 1
    fi
    echo "WARNING: upstream's own suite fails without the patch too, in exactly these tests;"
    echo "         the patch adds no failure of its own:"
    sed 's/^/           /' "$work/pristine.failed"
  fi

  echo "== opengym-ha patch tests"
  OPENGYM_API_DIR="$work/api" node --test /patches/test/*.test.mjs
  echo "== done: the patch applies, adds no upstream failure, and its own tests pass"
  exit 0
fi

if [ $# -ne 1 ]; then
  echo "usage: $0 <path-to-upstream-checkout>" >&2
  exit 2
fi
if [ ! -f "$1/api/server.js" ]; then
  echo "$1 is not an openGym checkout (no api/server.js)" >&2
  exit 2
fi
upstream=$(cd "$1" && pwd)
here=$(cd "$(dirname "$0")" && pwd)
exec docker run --rm \
  -v "$upstream:/upstream:ro" \
  -v "$here:/patches:ro" \
  "$IMAGE" sh /patches/run-tests.sh --in-container
