"""Client for the add-on gateway's /ha/v1 API and the summary coordinator.

Every failure is turned into one of the typed errors below, whose text is our
own. The gateway's response body is never read on an error path, so nothing it
(or anything behind it) says can leak into a log line or a service error.
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import quote

from aiohttp import ClientError, ClientSession, ClientTimeout
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from yarl import URL

from .const import (
    DOMAIN,
    EVENT_WORKOUT_COMPLETED,
    PATH_BODYWEIGHT,
    PATH_SUMMARY,
    SCAN_INTERVAL,
)

_LOGGER = logging.getLogger(__name__)
# Generous for the write path: the gateway may GET + PUT the profile up to
# three times when openGym reports a concurrent change (contract §7).
_TIMEOUT = ClientTimeout(total=15)


class OpenGymError(Exception):
    """Talking to the openGym gateway failed."""


class OpenGymAuthError(OpenGymError):
    """The gateway rejected the integration token (401/403)."""


class OpenGymConnectionError(OpenGymError):
    """No answer, a timeout, or an answer that is not the JSON we expect."""


class OpenGymResponseError(OpenGymError):
    """Any other non-2xx status. Only the status code is kept."""

    def __init__(self, status: int) -> None:
        super().__init__(f"openGym answered HTTP {status}")
        self.status = status


def base_url(host: str, port: int) -> URL:
    """``http://{host}:{port}`` (contract §9).

    yarl brackets an IPv6 literal and raises ValueError for anything that is
    not a bare hostname or IP (e.g. "http://x" or "x/y"), which the config
    flow reports as an invalid host instead of a confusing connection error.
    """
    return URL.build(scheme="http", host=host, port=port)


class OpenGymClient:
    """Minimal async client for the gateway's integration API."""

    def __init__(self, session: ClientSession, host: str, port: int, token: str) -> None:
        self._session = session
        self._base = base_url(host, port)
        self._headers = {"Authorization": f"Bearer {token}"}

    async def async_get_summary(self) -> dict[str, Any]:
        data = await self._request("GET", PATH_SUMMARY)
        # A 200 from something that is not the gateway (another service on the
        # port) must not pass the config flow's probe.
        if not isinstance(data.get("profiles"), list):
            raise OpenGymConnectionError("openGym sent an unexpected summary")
        return data

    async def async_log_body_weight(
        self, profile_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        # The id comes from the gateway's own summary; quoting it anyway keeps
        # a "/" or ".." in an id from ever addressing a different route.
        path = PATH_BODYWEIGHT.format(profile_id=quote(profile_id, safe=""))
        return await self._request("POST", path, payload)

    async def _request(
        self, method: str, path: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        url = self._base.with_path(path, encoded=True)
        try:
            async with self._session.request(
                method, url, headers=self._headers, json=payload, timeout=_TIMEOUT
            ) as resp:
                if resp.status in (401, 403):
                    raise OpenGymAuthError("openGym rejected the integration token")
                if resp.status >= 400:
                    raise OpenGymResponseError(resp.status)
                data = await resp.json()
        except (ClientError, TimeoutError, ValueError) as err:
            # ValueError: a body that is not JSON. ClientError includes a
            # non-JSON content type (ContentTypeError).
            _LOGGER.debug("openGym %s %s failed: %r", method, path, err)
            raise OpenGymConnectionError("openGym is not responding") from err
        if not isinstance(data, dict):
            raise OpenGymConnectionError("openGym sent an unexpected answer")
        return data


def _workout_order(workout: dict[str, Any]) -> tuple[str, str]:
    """Sort key for "which workout is newer": local date, then end time.

    Both are strings the gateway formats the same way every time
    (YYYY-MM-DD and ISO-8601 UTC), so comparing them as strings is ordering.
    """
    return (str(workout.get("date") or ""), str(workout.get("ended_at") or ""))


type OpenGymConfigEntry = ConfigEntry[OpenGymCoordinator]


class OpenGymCoordinator(DataUpdateCoordinator[dict[str, dict[str, Any]]]):
    """Polls GET /ha/v1/summary; ``data`` is the profiles keyed by profile id."""

    config_entry: OpenGymConfigEntry

    def __init__(
        self, hass: HomeAssistant, entry: OpenGymConfigEntry, client: OpenGymClient
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=DOMAIN,
            update_interval=SCAN_INTERVAL,
        )
        self.client = client
        # profile id -> its last_workout at the previous successful refresh.
        # None until the first refresh, so history that existed before Home
        # Assistant started watching never fires an event.
        self._last_workouts: dict[str, Any] | None = None

    async def _async_update_data(self) -> dict[str, dict[str, Any]]:
        try:
            summary = await self.client.async_get_summary()
        except OpenGymAuthError as err:
            # Starts the reauth flow (and fails setup, if this is the first refresh).
            raise ConfigEntryAuthFailed(str(err)) from err
        except OpenGymError as err:
            raise UpdateFailed(str(err)) from err

        profiles = {
            profile["id"]: profile
            for profile in summary["profiles"]
            if isinstance(profile, dict) and isinstance(profile.get("id"), str)
        }
        self._fire_workout_events(profiles)
        return profiles

    def _fire_workout_events(self, profiles: dict[str, dict[str, Any]]) -> None:
        previous = self._last_workouts
        self._last_workouts = {pid: p.get("last_workout") for pid, p in profiles.items()}
        if previous is None:
            return
        for pid, profile in profiles.items():
            if pid not in previous:
                # A profile seen for the first time: its newest workout is
                # history, not something that just happened.
                continue
            new = profile.get("last_workout")
            if not isinstance(new, dict) or not new.get("id"):
                continue
            old = previous[pid]
            if isinstance(old, dict):
                if new["id"] == old.get("id"):
                    continue
                if _workout_order(new) < _workout_order(old):
                    # Deleting the newest workout makes an older one "last"
                    # again — that is not a workout being completed.
                    continue
            self.hass.bus.async_fire(
                EVENT_WORKOUT_COMPLETED,
                {
                    "profile_id": pid,
                    "profile_name": profile.get("name"),
                    "date": new.get("date"),
                    "routine_name": new.get("routine_name"),
                    "duration_min": new.get("duration_min"),
                },
            )
