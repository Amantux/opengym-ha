# Changelog

## 0.1.0

First release: openGym 1.4.1 as a Home Assistant add-on.

- Open openGym from the Home Assistant sidebar already signed in. Every household member gets
  their own profile the first time they open it, with no account or passkey to set up.
- The first person to open openGym becomes its admin; the add-on log says who.
- The openGym integration is found automatically. Each profile gets sensors for body weight,
  last workout, workouts this week and in the last 7 days, and today's routine.
- Log weigh-ins from Home Assistant with `opengym.log_body_weight` (a smart scale, for example),
  read everything with `opengym.get_summary`, and automate on `opengym_workout_completed`.
- Optional direct access through your own https reverse proxy (`external_url`), for the openGym
  phone app and passkeys. Off by default: without it, only Home Assistant can reach openGym.
- Built on your device from the official openGym images, so the licensed exercise media is
  never re-hosted. Data lives in the add-on's own folder and is included in Home Assistant
  backups, which run without stopping openGym.
