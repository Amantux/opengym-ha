# Shared by both ingress prefixes in fake-ingress.conf. (proxy_set_header in a location
# replaces every inherited one, so these live in the location via include, not at server level.)
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header X-Forwarded-Host $http_host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
# Streamed both ways, like the Supervisor's aiohttp proxy.
proxy_buffering off;
proxy_request_buffering off;
# The Supervisor's ingress proxy reads a request body whole into an aiohttp app capped at
# 16 MiB (supervisor/api/__init__.py MAX_CLIENT_SIZE), except a POST to an add-on with
# ingress_stream, which it streams with no length. Emulated here: a non-POST body declaring more
# than ~16 MiB is refused with 413 (the regex is 17,000,000 bytes and up), a POST streams.
set $supervisor_cap "";
if ($request_method != POST) { set $supervisor_cap "B"; }
if ($content_length ~ "^([0-9]{9,}|1[7-9][0-9]{6}|[2-9][0-9]{7})$") { set $supervisor_cap "${supervisor_cap}L"; }
if ($supervisor_cap = "BL") { return 413; }
