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
