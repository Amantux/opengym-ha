# openGym Home Assistant add-on.
#
# Built LOCALLY by the Supervisor from this folder (config.yaml has no `image:`), on top of
# the official upstream images pinned by digest. The exercise media bundled in the web image
# is licensed to openGym only, so this repository never publishes an image that carries it.
# build.yaml passes BUILD_FROM per architecture; the default is the same multi-arch ref, so a
# plain `docker build opengym/` produces the same thing.
ARG BUILD_FROM=ghcr.io/duartesantos8/opengym-api:1.4.1@sha256:4bc07fe7d1f05a57c0fa25da3563d54dfe27223506637d67fc64088a2a2f140b

# Only a source of files (the built SPA, the exercise media, upstream's nginx server
# template); none of its runtime is used.
FROM ghcr.io/duartesantos8/opengym-web:1.4.1@sha256:e32cae9d2f4aad0c5e1b7888c9bfc712b2306ddfe3c65bc4cfefd4b0002e86d3 AS web

FROM ${BUILD_FROM}

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
COPY --from=web /etc/nginx/templates/default.conf.template /etc/opengym/nginx/default.conf.template

# Our nginx main config (replaces the package's) and the entrypoint.
COPY rootfs/ /

# nginx runs as `app`: give it the one directory it writes (pid and temp files, see
# rootfs/etc/nginx/nginx.conf) and the parent it must traverse, nothing recursive. The
# package's own server block (listen 80) goes; nginx.conf includes only the one the
# entrypoint renders.
RUN chmod 0755 /usr/local/bin/opengym-entrypoint.sh \
 && rm -f /etc/nginx/http.d/default.conf \
 && chown app:app /var/lib/nginx /var/lib/nginx/tmp

# The gateway's /healthz proxies upstream's /api/health, which answers 503 when the data
# directory is not writable, so healthy means the gateway answers AND the api can use /data.
# A dead nginx is caught by the entrypoint's supervision, which stops the add-on.
HEALTHCHECK --interval=1m --timeout=5s --start-period=1m --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8099/healthz || exit 1

# No USER line, on purpose: the container starts as root so the entrypoint can chown the
# Supervisor-managed /data (whose ownership we don't control) and create /run/opengym. It then
# runs every process (api, nginx, gateway, discovery) as `app` (uid 1000) through gosu.
ENTRYPOINT ["/usr/local/bin/opengym-entrypoint.sh"]
# Upstream's CMD ["node", "server.js"] must never reach the entrypoint as arguments.
CMD []
