# Security Policy

openGym for Home Assistant packages [openGym](https://github.com/DuarteSantos8/openGym)
as a Home Assistant add-on with ingress single sign-on, plus a companion integration.
It runs on the operator's own hardware behind Home Assistant, typically for one
household.

## Supported versions

Only the latest published version receives security fixes. Please update the
add-on and the integration before reporting an issue.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — do not open a public
issue containing exploit details.

- Preferred: this repository's **Security** tab → **Report a vulnerability**
  (GitHub private advisory).
- If that is unavailable, open a minimal issue asking for a private contact and
  withhold specifics until we follow up.

Please include the affected version, a description, and reproduction steps or a
proof of concept. We aim to acknowledge within a few days.

## Scope notes

In scope — anything this repository adds:

- Signing in as a Home Assistant user from anywhere other than the ingress peer
  (`172.30.32.2`), or as a different HA user than the one ingress names.
- Reaching the api's internal listener (`/run/opengym/internal.sock`) from the
  network, or the openGym web UI/api through the add-on's port while direct access
  is off.
- Using the integration API (`/ha/v1`) without the integration token, or writing
  to one profile through another's request.
- A credential, session or upstream error body leaking through the gateway, the
  integration, or the add-on logs.

Out of scope here, but please report them upstream (see openGym's own
[SECURITY.md](https://github.com/DuarteSantos8/openGym/blob/main/SECURITY.md)):
vulnerabilities in openGym itself that do not depend on this packaging.

Secrets — the integration token in `/data/gateway/integration_token`, openGym's
signing key under `/data/opengym/`, add-on options — live on storage the
operator already controls; access to the add-on configuration or `/data` is
trusted.
