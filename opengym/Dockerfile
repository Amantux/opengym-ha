# openGym Home Assistant add-on.
#
# Built LOCALLY by the Supervisor from this folder (config.yaml has no `image:`), on top of
# the official upstream images pinned by digest. The exercise media bundled in the web image
# is licensed to openGym only, so this repository never publishes an image that carries it.
#
# Both upstream images are named in plain FROM lines, which the Upstream sync workflow moves
# together with OPENGYM_VERSION below on each upstream release (tools/upstream_sync.py; nothing
# else in this file may change in that commit). Each digest is a multi-arch index (linux/amd64
# and linux/arm64), so one reference serves both add-on archs.
# There is no build.yaml and no ARG BUILD_FROM, on purpose: the Supervisor deprecated
# build.yaml in 2026.04, and an older Supervisor that finds no build.yaml passes
# BUILD_FROM=<Home Assistant's own base image>, which would replace an ARG's default. With no
# ARG it is an unused build argument, and the build ignores it.

# Only a source of files (the built SPA, the exercise media, upstream's nginx server
# template); none of its runtime is used...
FROM ghcr.io/duartesantos8/opengym-web:1.4.1@sha256:e32cae9d2f4aad0c5e1b7888c9bfc712b2306ddfe3c65bc4cfefd4b0002e86d3 AS web
# ...and of the defaults its ENV gives that template's ${NAME} variables, which no file holds
# (openGym 1.4.2's Content-Security-Policy is one): a NAME=value line for each variable the
# template uses and this image declares. The entrypoint renders the template with them. In /tmp:
# the image runs as an unprivileged user, which cannot write to /.
RUN for name in $(grep -o '\${[A-Z_][A-Z0-9_]*}' /etc/nginx/templates/default.conf.template \
      | tr -d '${}' | sort -u); do \
      if value=$(printenv "$name"); then printf '%s=%s\n' "$name" "$value"; fi; \
    done > /tmp/opengym-template-defaults.env

FROM ghcr.io/duartesantos8/opengym-api:1.4.1@sha256:4bc07fe7d1f05a57c0fa25da3563d54dfe27223506637d67fc64088a2a2f140b

# Passed by the Supervisor. "dev" marks a hand build.
ARG BUILD_VERSION=dev
ARG BUILD_ARCH

LABEL io.hass.version="${BUILD_VERSION}" \
      io.hass.type="addon" \
      io.hass.arch="${BUILD_ARCH}"

# Reported by the gateway's /ha/v1/health (contract §3, §10).
ENV OPENGYM_HA_VERSION=${BUILD_VERSION} \
    OPENGYM_VERSION=1.4.1

COPY patches/ /tmp/opengym-patches/

# - nginx serves upstream's SPA and media and proxies /api with upstream's own template.
# - gosu drops from root to `app`. gettext-envsubst is the envsubst binary alone (the full
#   gettext package is 14 MiB more). tzdata lets the time zone read from Home Assistant
#   resolve for musl as well as for node.
# - Every patch in patches/ is applied to the pinned api, in order (a glob expands sorted).
#   --fuzz=0: a hunk that does not match the pinned source exactly fails the build instead of
#   landing somewhere nearby. --forward --batch: an already-applied patch is a failure, never
#   a prompt. No patches at all is a failure too: the add-on cannot sign anyone in without
#   them. `patch` itself is build-only and leaves in this same layer.
# - uid 1000 is the base image's `node` user. It is replaced by `app` (same uid/gid, HOME
#   /home/app), the privilege model the sibling add-ons share, so /data stays owned by 1000.
#   Upstream's `coach` user (uid 1001) is left as it is.
RUN apk add --no-cache nginx gettext-envsubst gosu tzdata \
 && apk add --no-cache --virtual .patch-deps patch \
 && for p in /tmp/opengym-patches/*.patch; do \
      [ -f "$p" ] || { echo "no patches found in patches/" >&2; exit 1; }; \
      echo "applying ${p##*/}"; \
      patch -p1 --fuzz=0 --forward --batch --no-backup-if-mismatch -d /app -i "$p" || exit 1; \
    done \
 && apk del --no-cache .patch-deps \
 && rm -rf /tmp/opengym-patches \
 && deluser node \
 && rm -rf /home/node \
 && addgroup -g 1000 app \
 && adduser -D -u 1000 -G app -h /home/app -s /sbin/nologin app

# The gateway has no dependencies (contract §2): its source and the package.json that marks
# it an ES module. Its tests stay out of the image.
COPY gateway/package.json /opt/gateway/package.json
COPY gateway/src/ /opt/gateway/src/

COPY --from=web /usr/share/nginx/html/ /usr/share/nginx/html/
# The gateway's page-side half (contract §6 step 6): loaded before the app, so the app's photo
# and video uploads can stream through ingress. It does nothing outside ingress. ?v= makes a
# browser fetch the new copy after an update. The build fails unless upstream's index.html has
# exactly one <head> to put it in.
COPY gateway/web/ha-ingress.js /usr/share/nginx/html/ha-ingress.js
RUN node -e '\
  const fs = require("fs"); const f = "/usr/share/nginx/html/index.html"; \
  const html = fs.readFileSync(f, "utf8"); const n = html.split("<head>").length - 1; \
  if (n !== 1) { console.error(`index.html: expected one <head>, found ${n}`); process.exit(1); } \
  fs.writeFileSync(f, html.replace("<head>", `<head>\n<script src="./ha-ingress.js?v=${process.argv[1]}"></script>`));' \
  "${BUILD_VERSION}"
COPY --from=web /etc/nginx/templates/default.conf.template /etc/opengym/nginx/default.conf.template
COPY --from=web /tmp/opengym-template-defaults.env /etc/opengym/nginx/template-defaults.env

# install_integration: the HACS integration, bundled as integration/ because the build context
# is this folder (tools/sync_integration.py keeps it identical to custom_components/opengym).
# The entrypoint's installer copies it into Home Assistant's custom_components. Root-owned;
# the app user can only read it.
COPY integration/opengym/ /opt/opengym/integration/opengym/

# Our nginx main config (replaces the package's), the entrypoint and the integration installer.
COPY rootfs/ /

# nginx runs as `app`: give it the one directory it writes (pid and temp files, see
# rootfs/etc/nginx/nginx.conf) and the parent it must traverse, nothing recursive. The
# package's own server block (listen 80) goes; nginx.conf includes only the one the
# entrypoint renders.
RUN chmod 0755 /usr/local/bin/opengym-entrypoint.sh /usr/local/bin/opengym-install-integration.sh \
 && rm -f /etc/nginx/http.d/default.conf \
 && chown app:app /var/lib/nginx /var/lib/nginx/tmp

# The gateway's /healthz proxies upstream's /api/health, which answers 503 when the data
# directory is not writable, so healthy means the gateway answers AND the api can use /data.
# A dead nginx is caught by the entrypoint's supervision, which stops the add-on.
HEALTHCHECK --interval=1m --timeout=5s --start-period=1m --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8099/healthz || exit 1

# No USER line, on purpose: the container starts as root so the entrypoint can chown the
# Supervisor-managed /data (whose ownership we don't control) and create /run/opengym. It then
# runs every server (api, nginx, gateway) as `app` (uid 1000) through gosu. Supervisor
# discovery alone stays root, so that SUPERVISOR_TOKEN never sits in an environment uid 1000
# can read (see the entrypoint).
ENTRYPOINT ["/usr/local/bin/opengym-entrypoint.sh"]
# Upstream's CMD ["node", "server.js"] must never reach the entrypoint as arguments.
CMD []
