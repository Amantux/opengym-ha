# openGym

[openGym](https://github.com/DuarteSantos8/openGym) is a self-hosted gym and body-weight
tracker: plan routines, log workouts (supersets and cardio too), track your weight and see your
progress. This add-on runs it inside Home Assistant. Open **openGym** from the sidebar and you
are already signed in as your Home Assistant user. There is no separate account to create.

## Open it yourself first

**The first person to open openGym becomes its admin.** Install the add-on, start it, and open
**openGym** from the sidebar yourself before anyone else in your household does.

The add-on log confirms who it was:

```text
openGym: HA user Alex is the openGym admin (first profile on this instance)
```

The admin finds the **Admin dashboard** under **Settings → Account** in openGym: who is
training, each profile's history and body weight, disabling accounts, invite codes and the AI
Coach.

## Everyone gets their own profile

- Every Home Assistant user sees openGym in the sidebar, not only Home Assistant admins.
- The first time someone opens it, openGym creates their own profile, named after their Home
  Assistant display name. Workouts, routines and weigh-ins are separate per profile.
- The name is set once, when the profile is created. Changing your name in Home Assistant later
  does not rename your openGym profile.

## Signing out

- **Sign out** only clears openGym on this device. Home Assistant is your sign-in, so the next
  time you open openGym from the sidebar you are signed straight back in.
- **To keep someone out of openGym**, the admin opens **Admin dashboard**, picks their profile
  and chooses **Disable account**. **Enable account** lets them back in.
- **Do not use Delete account for a Home Assistant user.** Their profile and data are deleted,
  and the next time they open openGym they simply get a new, empty profile. Use **Disable
  account** instead.

## Options

All options are optional. With the defaults, openGym works from the sidebar and nowhere else.

| Option | Default | What it does |
| --- | --- | --- |
| `external_url` | blank | The https address of your own reverse proxy in front of port 8099, for example `https://gym.example.com`. Blank = direct access is refused. See below. |
| `password_login` | off | Offer **Sign in with password** on direct access, for profiles that have a password. |
| `invite_only` | off | New profiles made on direct access need an invite code from the admin. Home Assistant users always get their profile. |
| `allow_guest` | off | Show **Continue without account**. A guest's data stays in that one browser: no sync, no backup. |
| `default_lang` | blank | Language the sign-in screen and new profiles start in, such as `de` or `pt-BR`. Blank = each browser's own language. |

If an option is invalid (for example an `external_url` with a path in it), the add-on refuses
to start and its log lists every problem at once. Fix them and start it again.

## Use openGym outside Home Assistant (direct access)

Inside Home Assistant you need nothing else, in the browser and in the Home Assistant
Companion app. Set up direct access only if you want the **openGym phone app**, passkeys, or
openGym on its own address.

1. Run an https reverse proxy you control (Caddy, Nginx Proxy Manager, Traefik, a Cloudflare
   Tunnel, ...) for a host name such as `gym.example.com`, forwarding to port 8099 on your Home
   Assistant machine.
2. In the add-on's **Network** tab, map port 8099.
3. On the **Configuration** tab, set `external_url` to that address, for example
   `https://gym.example.com`. Save and restart the add-on. The log then says
   `direct access on port 8099 is ON`.

Things to know:

- **Passkeys need https and are tied to that host name.** Choose it before people register:
  changing `external_url` later stops every passkey made for the old address from working.
- Without `external_url`, port 8099 refuses everything except Home Assistant itself, even when
  the port is mapped. This stops other devices on your network from creating profiles.
- In your proxy, let at least 5 MB through on `/api/` (openGym syncs a whole workout history in
  one request) and 48 MB on `/api/media/` (photos and videos of your own exercises). Do not add
  CORS headers or a login page (SSO, forward-auth) in front of `/api/`: openGym answers those
  itself, and the phone app cannot pair through them.
- **Profiles made by Home Assistant have no passkey or password**, and openGym asks for one of
  those before it adds another. So a Home Assistant profile signs in through Home Assistant only,
  but it *can* pair the phone app (below).
- Someone without a Home Assistant account can create their own profile on the direct address,
  with a passkey (or a password when `password_login` is on). That profile is separate and is
  not linked to any Home Assistant user.
- With `password_login` on, a profile made on the direct address can set a password under
  **Settings → Account → Password**. Switching `password_login` off again locks out profiles
  whose only way in is a password, so have them add a passkey first.

### Pair the openGym phone app

1. Set up direct access as above.
2. Open openGym from the Home Assistant sidebar and go to **Settings → Account → Pair the mobile
   app**. A one-time code appears; it is valid for 5 minutes.
3. In the phone app, choose to connect to your own server, enter your `external_url` address and
   the code.

**Sign out everywhere** (Settings → Account) also unpairs every phone; pair it again afterwards.
Nothing on the phone is lost in the meantime. The Android app can also pair with a plain
`http://` address on your home network, but the code and the app's token then cross your network
unencrypted, and passkeys do not work over http.

## The Home Assistant integration

The add-on announces itself to Home Assistant. After it starts, go to **Settings → Devices &
services**: openGym shows up as discovered. Select **Add** to set it up; there is nothing to
type. The dialog names the add-on that announced itself: accept it only for the openGym add-on
you installed. From then on the integration listens to that add-on only; an announcement from
any other add-on changes nothing.

- **There is no token to copy.** The add-on is set up by discovery, and on Home Assistant OS you
  cannot read its token file anyway. If the integration ever says openGym rejected its token (for
  example after you reinstalled the add-on), restart the add-on: it announces its current token
  again and the integration reloads itself. If it is still not connected after that, restart
  Home Assistant.
- **Reinstalled openGym from a different add-on repository?** Home Assistant sees that as a
  different add-on. Delete the openGym integration (**Settings → Devices & services → openGym**),
  then add the new one when it shows up as discovered. Restart Home Assistant if it does not.
- **Adding openGym by hand** (host, port and token) is only for an openGym gateway that runs
  outside Home Assistant.

Each openGym profile becomes a device with these sensors, refreshed every minute:

| Sensor | Shows |
| --- | --- |
| Body weight | The latest weigh-in, in the profile's unit. Kept as long-term statistics, so it graphs like any other Home Assistant sensor. |
| Last workout | When the latest workout ended. |
| Workouts this week | Workouts since the start of this week. |
| Workouts last 7 days | Workouts in the last 7 days. |
| Today's routine | The routine planned for today, or `Rest day`. |

A new household member's device appears on its own once they have opened openGym.

### Actions

Every Home Assistant user can run these actions, for any profile: Home Assistant has no
per-user permissions for actions.

**`opengym.log_body_weight`** records a weigh-in, for example from a smart scale.

| Field | |
| --- | --- |
| `profile` | The profile's id, or its exact name (not case-sensitive). |
| `weight` | The measured weight. openGym converts it to the profile's own unit. |
| `unit` | `kg` or `lb`, required. For a scale sensor, use the unit the sensor shows: Home Assistant does not convert weight sensors to your unit system. |
| `date` | Day of the weigh-in. Defaults to today in Home Assistant's time zone. |

A profile keeps one weigh-in per day, so a second one on the same day replaces the first. The
person has to have logged something in openGym (a workout, a weigh-in or any setting) before Home
Assistant can log weight for them: opening the app alone does not create their data yet.

**`opengym.get_summary`** returns every profile's body weight, last workout, workout counts and
today's routine (or just one, with `profile`). Use it in a script with `response_variable`.

### Event

**`opengym_workout_completed`** fires when a profile logs a new workout, within about a minute.
Its data: `profile_id`, `profile_name`, `date`, `routine_name`, `duration_min`.

It fires once per workout, and not for workouts that already existed when the integration
started, or for an older workout that is the latest again because a newer one was deleted. When
Home Assistant has seen no earlier workout for a profile, the workout must have ended in the last
24 hours (without an end time: be dated today or yesterday), so history imported from another
app is not announced.

### Example: log weight from a smart scale

```yaml
automation:
  - alias: "Log my weigh-in in openGym"
    triggers:
      - trigger: state
        entity_id: sensor.bathroom_scale_weight
        # Only a new reading: not the scale coming back from "unavailable" or
        # "unknown" (a restart, a reload, a failed cloud poll) with its old
        # value, and not a change to its attributes alone.
        not_from:
          - unavailable
          - unknown
    conditions:
      # A number, in a unit openGym takes.
      - condition: template
        value_template: >-
          {{ trigger.to_state.state | is_number
             and trigger.to_state.attributes.unit_of_measurement in ['kg', 'lb'] }}
    actions:
      - action: opengym.log_body_weight
        data:
          profile: Alex
          weight: "{{ trigger.to_state.state | float }}"
          unit: "{{ trigger.to_state.attributes.unit_of_measurement }}"
```

### Example: a notification when a workout finishes

```yaml
automation:
  - alias: "Tell me when a workout is done"
    triggers:
      - trigger: event
        event_type: opengym_workout_completed
    actions:
      - action: notify.mobile_app_my_phone
        data:
          title: "Workout logged"
          message: >-
            {{ trigger.event.data.profile_name }} finished
            {{ trigger.event.data.routine_name or 'a workout' }}
            {%- if trigger.event.data.duration_min %} in {{ trigger.event.data.duration_min }} min{% endif %}.
```

Replace `sensor.bathroom_scale_weight`, `Alex` and `notify.mobile_app_my_phone` with your own.

## AI Coach

openGym's AI Coach designs a training plan and revises it from what you log. It is off until the
admin turns it on in **Admin dashboard → AI Coach**.

- **Works:** the providers that take an API key and are reached over the network: Anthropic,
  OpenAI, Google Gemini, or an OpenAI-compatible endpoint (such as a model server on your own
  network).
- **Not supported in the add-on:** the providers that run a program inside the container
  (Claude through the Agent SDK, and Codex). openGym only runs those when its server runs as
  root so it can hand each job to a separate user, and this add-on never runs openGym as root.

Provider API keys are stored with your data, encrypted with the add-on's own secret.

## Backups and where your data lives

Everything openGym keeps is in the add-on's own data folder, which Home Assistant backups
include:

- `/data/opengym`: every profile, passkey and workout history, the admin's activity log
  (sign-in times), the AI Coach settings, and photos and videos of your own exercises
  (`uploads/`, usually the largest part).
- `/data/gateway`: the token the Home Assistant integration uses.

Backups are taken while openGym keeps running. A backup holds everyone's training data and
sign-in history, so keep it somewhere you trust. Each person can also export their own data from
openGym: **Settings → Data & backup**.

## Limitations

- **No offline mode in the sidebar.** The panel is served through Home Assistant, so openGym
  needs a connection there. To train without signal, use the phone app (it keeps its own copy and
  syncs later).
- **Delete account re-creates an empty profile** for a Home Assistant user on their next visit.
  Use **Disable account** (see [Signing out](#signing-out)).
- **Passkeys cannot be created inside the Home Assistant panel**, and a profile made on the
  direct address cannot be joined to a Home Assistant profile.
- **Photos and videos upload from the sidebar at openGym's usual sizes** (videos up to 40 MB).
  Home Assistant holds an ordinary upload in memory and refuses anything over 16 MiB, so the
  add-on streams uploads instead: a small script it adds to openGym's page sends them in the one
  form Home Assistant streams, and the add-on hands them to openGym unchanged. Nothing changes
  on direct access.
- Inside the sidebar, openGym shares Home Assistant's address, so a security bug in openGym could
  reach Home Assistant. That is true of every add-on with a sidebar panel; keep the add-on
  updated.

## Licence

- openGym is free software by Duarte Santos, licensed under the AGPL-3.0. Its source is at
  <https://github.com/DuarteSantos8/openGym>. This add-on (its packaging, the small patch it
  applies to openGym, the sign-in gateway and the Home Assistant integration) is AGPL-3.0 as
  well: <https://github.com/Amantux/opengym-ha>.
- The exercise photos and animations are **not** covered by the AGPL. They are licensed to
  openGym by Gym visual (gymvisual.com) strictly for use within openGym. That is why this add-on
  is built on your device from the official openGym images instead of being downloaded as a
  ready-made image: nobody but openGym distributes them.
