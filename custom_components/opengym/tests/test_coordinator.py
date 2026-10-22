"""Coordinator: workout events, and how gateway failures surface."""

from __future__ import annotations

import copy

import pytest
from aiohttp import ClientError
from homeassistant.config_entries import SOURCE_REAUTH, ConfigEntryState
from homeassistant.const import STATE_UNAVAILABLE
from pytest_homeassistant_custom_component.common import async_capture_events

from custom_components.opengym.const import DOMAIN, EVENT_WORKOUT_COMPLETED
from custom_components.opengym.tests.common import (
    ALEX,
    NOVA,
    SAM,
    SUMMARY_URL,
    entity_id,
    make_entry,
    setup_entry,
    summary,
)

PUSH_B = {
    "id": "w-alex-2",
    "date": "2026-10-22",
    "started_at": "2026-10-22T17:00:00.000Z",
    "ended_at": "2026-10-22T17:45:00.000Z",
    "routine_name": "Pull B",
    "duration_min": 45,
}
# 15 minutes after PUSH_B ended.
NOW = "2026-10-22T18:00:00+00:00"


def _with_workout(profile, workout):
    changed = copy.deepcopy(profile)
    changed["last_workout"] = copy.deepcopy(workout)
    return changed


async def _refresh(hass, aioclient_mock, entry, **response):
    aioclient_mock.clear_requests()
    aioclient_mock.get(SUMMARY_URL, **response)
    await entry.runtime_data.async_refresh()
    await hass.async_block_till_done()


async def test_no_event_on_first_refresh_or_unchanged_refresh(hass, aioclient_mock):
    events = async_capture_events(hass, EVENT_WORKOUT_COMPLETED)
    entry = await setup_entry(hass, aioclient_mock, summary(ALEX, SAM))

    await _refresh(hass, aioclient_mock, entry, json=summary(ALEX, SAM))

    assert events == []


async def test_event_fires_when_last_workout_changes(hass, aioclient_mock):
    events = async_capture_events(hass, EVENT_WORKOUT_COMPLETED)
    entry = await setup_entry(hass, aioclient_mock, summary(ALEX, SAM))

    await _refresh(hass, aioclient_mock, entry, json=summary(_with_workout(ALEX, PUSH_B), SAM))

    assert [e.data for e in events] == [
        {
            "profile_id": ALEX["id"],
            "profile_name": "Alex",
            "date": "2026-10-22",
            "routine_name": "Pull B",
            "duration_min": 45,
        }
    ]
    # Once per workout, not once per poll.
    await _refresh(hass, aioclient_mock, entry, json=summary(_with_workout(ALEX, PUSH_B), SAM))
    assert len(events) == 1


async def test_first_ever_workout_of_a_known_profile_fires(hass, aioclient_mock, freezer):
    freezer.move_to(NOW)
    events = async_capture_events(hass, EVENT_WORKOUT_COMPLETED)
    entry = await setup_entry(hass, aioclient_mock, summary(NOVA))

    await _refresh(hass, aioclient_mock, entry, json=summary(_with_workout(NOVA, PUSH_B)))

    assert [e.data["profile_id"] for e in events] == [NOVA["id"]]


async def test_imported_history_is_not_a_completed_workout(hass, aioclient_mock, freezer):
    """Nova imports her Strong history: her newest workout is from last year."""
    freezer.move_to(NOW)
    events = async_capture_events(hass, EVENT_WORKOUT_COMPLETED)
    entry = await setup_entry(hass, aioclient_mock, summary(NOVA))
    imported = {
        **PUSH_B,
        "id": "iw-strong-1",
        "date": "2025-03-01",
        "started_at": "2025-03-01T09:00:00.000Z",
        "ended_at": "2025-03-01T10:00:00.000Z",
    }

    await _refresh(hass, aioclient_mock, entry, json=summary(_with_workout(NOVA, imported)))

    assert events == []


async def test_first_workout_ended_over_a_day_ago_does_not_fire(hass, aioclient_mock, freezer):
    freezer.move_to("2026-10-23T17:46:00+00:00")  # 24 h and 1 min after PUSH_B ended
    events = async_capture_events(hass, EVENT_WORKOUT_COMPLETED)
    entry = await setup_entry(hass, aioclient_mock, summary(NOVA))

    await _refresh(hass, aioclient_mock, entry, json=summary(_with_workout(NOVA, PUSH_B)))

    assert events == []


@pytest.mark.parametrize(
    ("date", "fires"),
    [("2026-10-23", True), ("2026-10-22", True), ("2026-10-21", False)],
)
async def test_first_workout_without_end_time_must_be_dated_today_or_yesterday(
    hass, aioclient_mock, freezer, date, fires
):
    # 12:30 UTC on the 22nd is already the 23rd in Auckland (NZDT): "today"
    # and "yesterday" are Home Assistant's, not UTC's.
    await hass.config.async_set_time_zone("Pacific/Auckland")
    freezer.move_to("2026-10-22T12:30:00+00:00")
    events = async_capture_events(hass, EVENT_WORKOUT_COMPLETED)
    entry = await setup_entry(hass, aioclient_mock, summary(NOVA))
    undated_end = {**PUSH_B, "date": date, "ended_at": None, "duration_min": None}

    await _refresh(hass, aioclient_mock, entry, json=summary(_with_workout(NOVA, undated_end)))

    assert len(events) == (1 if fires else 0)


async def test_a_poll_without_the_workout_does_not_announce_it_again(
    hass, aioclient_mock, freezer
):
    """openGym could not read the state file once: last_workout came back null."""
    freezer.move_to(NOW)
    events = async_capture_events(hass, EVENT_WORKOUT_COMPLETED)
    entry = await setup_entry(hass, aioclient_mock, summary(ALEX))
    await _refresh(hass, aioclient_mock, entry, json=summary(_with_workout(ALEX, PUSH_B)))
    assert len(events) == 1

    await _refresh(hass, aioclient_mock, entry, json=summary(_with_workout(ALEX, None)))
    await _refresh(hass, aioclient_mock, entry, json=summary(_with_workout(ALEX, PUSH_B)))

    assert len(events) == 1


async def test_no_event_for_a_profile_seen_for_the_first_time(hass, aioclient_mock):
    events = async_capture_events(hass, EVENT_WORKOUT_COMPLETED)
    entry = await setup_entry(hass, aioclient_mock, summary(ALEX))

    # Sam appears with a workout already logged: that is history.
    await _refresh(hass, aioclient_mock, entry, json=summary(ALEX, SAM))

    assert entry.runtime_data.last_update_success
    assert events == []


async def test_deleting_the_newest_workout_is_not_a_completion(hass, aioclient_mock):
    events = async_capture_events(hass, EVENT_WORKOUT_COMPLETED)
    entry = await setup_entry(hass, aioclient_mock, summary(_with_workout(ALEX, PUSH_B)))

    # PUSH_B deleted in openGym: the older "Push A" is the last workout again.
    await _refresh(hass, aioclient_mock, entry, json=summary(ALEX))

    assert events == []


async def test_workout_during_an_outage_fires_once_on_recovery(hass, aioclient_mock):
    events = async_capture_events(hass, EVENT_WORKOUT_COMPLETED)
    entry = await setup_entry(hass, aioclient_mock, summary(ALEX))

    await _refresh(hass, aioclient_mock, entry, exc=ClientError("refused"))
    await _refresh(hass, aioclient_mock, entry, json=summary(_with_workout(ALEX, PUSH_B)))

    assert len(events) == 1


async def test_gateway_error_makes_entities_unavailable(hass, aioclient_mock):
    entry = await setup_entry(hass, aioclient_mock, summary(ALEX))

    await _refresh(
        hass, aioclient_mock, entry, status=502, json={"error": "openGym is not responding"}
    )

    assert entry.runtime_data.last_update_success is False
    assert (
        hass.states.get(entity_id(hass, entry, ALEX["id"], "body_weight")).state
        == STATE_UNAVAILABLE
    )


async def test_rejected_token_during_polling_starts_reauth(hass, aioclient_mock):
    entry = await setup_entry(hass, aioclient_mock, summary(ALEX))

    await _refresh(hass, aioclient_mock, entry, status=401, json={"error": "unauthorized"})

    flows = hass.config_entries.flow.async_progress_by_handler(DOMAIN)
    assert [f["context"]["source"] for f in flows] == [SOURCE_REAUTH]
    assert flows[0]["context"]["entry_id"] == entry.entry_id


async def test_rejected_token_at_setup_fails_setup_and_starts_reauth(hass, aioclient_mock):
    aioclient_mock.get(SUMMARY_URL, status=401)
    entry = make_entry(hass)

    assert not await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.SETUP_ERROR
    flows = hass.config_entries.flow.async_progress_by_handler(DOMAIN)
    assert [f["context"]["source"] for f in flows] == [SOURCE_REAUTH]


async def test_unreachable_at_setup_retries(hass, aioclient_mock):
    aioclient_mock.get(SUMMARY_URL, exc=TimeoutError())
    entry = make_entry(hass)

    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.SETUP_RETRY
