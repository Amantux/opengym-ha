#!/bin/sh
# Copies the integration bundled in this image into Home Assistant's custom_components, for the
# install_integration option. The entrypoint runs it as root, before any server starts, under
# the add-on's main AppArmor profile: the only part of the add-on allowed to touch
# /homeassistant (node and nginx run in opengym//app, which denies it). So this script uses
# busybox only: a node started from here would land in that child profile too.
#
# Never fails the add-on's start: every outcome is one log line and exit 0.
#
# A copy it did not put there (HACS, by hand) is never touched. A copy it did put there carries
# MARK: its version, then the sha256 of the manifest.json it installed. It is replaced only when
# this image bundles a different version AND its manifest.json is still the one it installed, so
# a copy that changed since (HACS installing over it without removing the marker, a hand edit)
# is left alone too. Nothing is ever removed, also not when the option is turned off again: the
# integration may be in use.
# OPENGYM_INTEGRATION_SRC and OPENGYM_HA_CONFIG exist for tests/installer/test-installer.sh.
set -u

SRC=${OPENGYM_INTEGRATION_SRC:-/opt/opengym/integration/opengym}
HA=${OPENGYM_HA_CONFIG:-/homeassistant}
DIR=$HA/custom_components
DEST=$DIR/opengym
MARK=.installed-by-opengym-addon
# Fixed names, so a start that died halfway leaves nothing that piles up: each run clears them.
# Home Assistant skips a name with a dot in it when it looks for integrations.
TMP=$DIR/.opengym-addon-new
OLD=$DIR/.opengym-addon-old
VERSION_SHAPE='^[0-9A-Za-z.+-]\{1,32\}$'

say() { printf 'openGym: integration installer: %s\n' "$*"; }

want=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([0-9A-Za-z.+-]*\)".*/\1/p' "$SRC/manifest.json" 2>/dev/null | head -n 1)
if [ -z "$want" ]; then say "the bundled integration has no readable version; nothing installed."; exit 0; fi
want_sum=$(sha256sum "$SRC/manifest.json" 2>/dev/null | cut -d' ' -f1)
if [ -z "$want_sum" ]; then say "the bundled integration's manifest cannot be read; nothing installed."; exit 0; fi
if [ ! -d "$HA" ]; then say "Home Assistant's configuration folder is not mounted; nothing installed."; exit 0; fi
# Never follow a link out of the configuration folder.
for p in "$DIR" "$DEST" "$DEST/$MARK"; do
  if [ -L "$p" ]; then say "$p is a symbolic link; not touched."; exit 0; fi
done
if [ -e "$DEST" ] && [ ! -f "$DEST/$MARK" ]; then
  say "custom_components/opengym was installed another way (HACS or by hand); not touched."
  exit 0
fi
have=""
if [ -f "$DEST/$MARK" ]; then
  have=$(head -n 1 "$DEST/$MARK" 2>/dev/null)
  # Only a version ever goes into the log.
  if ! printf '%s\n' "$have" | grep -q "$VERSION_SHAPE"; then have=unknown; fi
  # Still the manifest.json this script installed? Only a plain file is read: a FIFO or a link
  # planted in its place counts as changed (and could not hang the add-on's start).
  pinned=$(sed -n 2p "$DEST/$MARK" 2>/dev/null)
  now=""
  if [ -f "$DEST/manifest.json" ] && [ ! -L "$DEST/manifest.json" ]; then
    now=$(sha256sum "$DEST/manifest.json" 2>/dev/null | cut -d' ' -f1)
  fi
  if [ -z "$now" ] || [ "$pinned" != "$now" ]; then
    say "custom_components/opengym changed since the add-on installed it (HACS or by hand); not touched."
    exit 0
  fi
fi
if [ "$have" = "$want" ]; then say "version $want is already installed."; exit 0; fi

if ! { mkdir -p "$DIR" && rm -rf "$TMP" "$OLD" && cp -R "$SRC" "$TMP" && printf '%s\n%s\n' "$want" "$want_sum" > "$TMP/$MARK"; }; then
  rm -rf "$TMP"
  say "could not write to custom_components; nothing installed."
  exit 0
fi
# Two renames: Home Assistant never sees a half-copied integration.
if [ -e "$DEST" ] && ! mv "$DEST" "$OLD"; then rm -rf "$TMP"; say "could not replace the old copy; nothing changed."; exit 0; fi
if ! mv "$TMP" "$DEST"; then
  if [ -e "$OLD" ]; then mv "$OLD" "$DEST"; fi
  rm -rf "$TMP"
  say "could not put the new copy in place; nothing changed."
  exit 0
fi
rm -rf "$OLD"
if [ -n "$have" ]; then
  say "updated the openGym integration from $have to $want. Restart Home Assistant to load it."
else
  say "installed the openGym integration $want. Restart Home Assistant (Settings > System > Restart) to load it; openGym then shows up under Settings > Devices & services."
fi
exit 0
