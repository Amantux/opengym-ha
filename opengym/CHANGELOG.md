# Changelog

## Unreleased

- openGym 1.4.3 ([what's new](https://github.com/DuarteSantos8/openGym/releases/tag/v1.4.3)).

## 0.1.4

- openGym 1.4.2 ([what's new](https://github.com/DuarteSantos8/openGym/releases/tag/v1.4.2)).

## 0.1.3

- Maintenance release; no user-visible change.

## 0.1.2

- New openGym releases now reach the add-on on their own: each is tested against everything the
  add-on relies on and, if it passes, released as the add-on's next version within the hour. The
  Documentation tab's new Updates section explains how that reaches you.

## 0.1.1

- Maintenance release; no user-visible change.

## 0.1.0

First release: openGym 1.4.1 as a Home Assistant add-on.

- Open openGym from the Home Assistant sidebar already signed in. Every household member gets
  their own profile the first time they open it, with no account or passkey to set up.
- The first person to open openGym becomes its admin; the add-on log says who.
- The openGym integration is found automatically, and only the openGym add-on that set it up
  can update it later. Each profile gets sensors for body weight, last workout, workouts this
  week and in the last 7 days, and today's routine.
- Log weigh-ins from Home Assistant with `opengym.log_body_weight` (a smart scale, for example;
  give the unit, `kg` or `lb`), read everything with `opengym.get_summary`, and automate on
  `opengym_workout_completed`, which fires for a workout just logged, not for imported history.
- Optional direct access through your own https reverse proxy (`external_url`), for the openGym
  phone app and passkeys. Off by default: without it, only Home Assistant can reach openGym.
- No HACS? Turn on `install_integration` and the add-on installs the openGym integration for
  you. It never overwrites a copy from HACS or one you put there by hand, and AppArmor keeps
  openGym itself away from Home Assistant's configuration folder.
- Photos and videos upload from the sidebar at openGym's own limits (videos up to 40 MB),
  streamed past Home Assistant's 16 MiB limit on ordinary uploads.
- Built on your device from the official openGym images, so the licensed exercise media is
  never re-hosted. Data lives in the add-on's own folder and is included in Home Assistant
  backups, which run without stopping openGym.
