"""Contract-shaped test data and helpers shared by the test modules.

Imported as custom_components.opengym.tests.common (conftest.py puts the repo
root on sys.path), so it works under any pytest import mode.
"""

from __future__ import annotations

import copy
from typing import Any

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.opengym.const import (
    ADDON_UNIQUE_ID,
    CONF_ADDON_SLUG,
    CONF_HOST,
    CONF_PORT,
    CONF_TOKEN,
    DOMAIN,
)

HOST = "local-opengym"
PORT = 8099
TOKEN = "integration-token-123"
# The Supervisor slug of a locally installed add-on with `slug: opengym`.
ADDON_SLUG = "local_opengym"
BASE = f"http://{HOST}:{PORT}"
SUMMARY_URL = f"{BASE}/ha/v1/summary"


def bodyweight_url(profile_id: str) -> str:
    return f"{BASE}/ha/v1/profiles/{profile_id}/bodyweight"


# Contract §7 shapes. Alex: kg, full data. Sam: lb, rest day. Nova: a user
# with no state file yet (nulls, zero counts, rest day, rev 0).
ALEX: dict[str, Any] = {
    "id": "alexId0000000001",
    "name": "Alex",
    "admin": True,
    "unit": "kg",
    "body_weight": {
        "value": 80.2,
        "unit": "kg",
        "date": "2026-10-21",
        "measured_at": "2026-10-21T05:30:00.000Z",
    },
    "last_workout": {
        "id": "w-alex-1",
        "date": "2026-10-21",
        "started_at": "2026-10-21T17:00:00.000Z",
        "ended_at": "2026-10-21T17:52:00.000Z",
        "routine_name": "Push A",
        "duration_min": 52,
    },
    "workouts_this_week": 3,
    "workouts_7d": 4,
    "today": {
        "date": "2026-10-22",
        "routine_id": "r-pull-b",
        "routine_name": "Pull B",
        "rest_day": False,
    },
    "rev": 42,
}
SAM: dict[str, Any] = {
    "id": "samId00000000002",
    "name": "Sam",
    "admin": False,
    "unit": "lb",
    "body_weight": {
        "value": 176.4,
        "unit": "lb",
        "date": "2026-10-20",
        "measured_at": "2026-10-20T06:00:00.000Z",
    },
    "last_workout": {
        "id": "w-sam-1",
        "date": "2026-10-19",
        "started_at": "2026-10-19T07:00:00.000Z",
        "ended_at": "2026-10-19T07:40:00.000Z",
        "routine_name": "Legs",
        "duration_min": 40,
    },
    "workouts_this_week": 1,
    "workouts_7d": 2,
    "today": {"date": "2026-10-22", "routine_id": None, "routine_name": None, "rest_day": True},
    "rev": 7,
}
NOVA: dict[str, Any] = {
    "id": "novaId0000000003",
    "name": "Nova",
    "admin": False,
    "unit": "kg",
    "body_weight": None,
    "last_workout": None,
    "workouts_this_week": 0,
    "workouts_7d": 0,
    "today": {"date": "2026-10-22", "routine_id": None, "routine_name": None, "rest_day": True},
    "rev": 0,
}


def summary(*profiles: dict[str, Any]) -> dict[str, Any]:
    """A summary body; deep-copied so a test can mutate its profiles freely."""
    return {
        "generated_at": "2026-10-22T10:00:00.000Z",
        "profiles": [copy.deepcopy(p) for p in profiles],
    }


def make_entry(hass, token: str = TOKEN, unique_id: str = ADDON_UNIQUE_ID) -> MockConfigEntry:
    data: dict[str, Any] = {CONF_HOST: HOST, CONF_PORT: PORT, CONF_TOKEN: token}
    if unique_id == ADDON_UNIQUE_ID:
        data[CONF_ADDON_SLUG] = ADDON_SLUG  # made by that add-on's discovery
    entry = MockConfigEntry(domain=DOMAIN, title="openGym", unique_id=unique_id, data=data)
    entry.add_to_hass(hass)
    return entry


async def setup_entry(hass, aioclient_mock, body: dict[str, Any] | None = None) -> MockConfigEntry:
    """Add an entry, serve `body` as the summary, and set it up."""
    aioclient_mock.get(SUMMARY_URL, json=body if body is not None else summary(ALEX, SAM, NOVA))
    entry = make_entry(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def calls(aioclient_mock, method: str, fragment: str) -> list:
    """Recorded (method, url, data, headers) calls whose URL contains `fragment`."""
    return [
        c for c in aioclient_mock.mock_calls if c[0].lower() == method and fragment in str(c[1])
    ]


def entity_id(hass, entry, profile_id: str, key: str) -> str:
    """The entity id registered for one profile's sensor."""
    from homeassistant.helpers import entity_registry as er

    found = er.async_get(hass).async_get_entity_id(
        "sensor", DOMAIN, f"{entry.entry_id}_{profile_id}_{key}"
    )
    assert found is not None, (profile_id, key)
    return found
