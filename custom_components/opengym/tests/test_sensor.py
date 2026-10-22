"""Sensors: one device per profile, five sensors each, contract §7 fields."""

from __future__ import annotations

from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from custom_components.opengym.const import DOMAIN
from custom_components.opengym.tests.common import (
    ALEX,
    NOVA,
    SAM,
    SUMMARY_URL,
    entity_id,
    setup_entry,
    summary,
)

KEYS = ("body_weight", "last_workout", "workouts_this_week", "workouts_7d", "today_routine")


async def test_one_device_per_profile_with_five_named_sensors(hass, aioclient_mock):
    entry = await setup_entry(hass, aioclient_mock)

    devices = dr.async_entries_for_config_entry(dr.async_get(hass), entry.entry_id)
    assert sorted(d.name for d in devices) == ["Alex", "Nova", "Sam"]
    entities = er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)
    assert len(entities) == 3 * len(KEYS)

    # has_entity_name + translation keys: "<device> <translated name>".
    names = {
        key: hass.states.get(entity_id(hass, entry, ALEX["id"], key)).attributes["friendly_name"]
        for key in KEYS
    }
    assert names == {
        "body_weight": "Alex Body weight",
        "last_workout": "Alex Last workout",
        "workouts_this_week": "Alex Workouts this week",
        "workouts_7d": "Alex Workouts last 7 days",
        "today_routine": "Alex Today's routine",
    }


async def test_kg_profile(hass, aioclient_mock):
    entry = await setup_entry(hass, aioclient_mock)

    weight = hass.states.get(entity_id(hass, entry, ALEX["id"], "body_weight"))
    assert weight.state == "80.2"
    assert weight.attributes["unit_of_measurement"] == "kg"
    assert weight.attributes["device_class"] == "weight"
    assert weight.attributes["state_class"] == "measurement"
    assert weight.attributes["date"] == "2026-10-21"

    last = hass.states.get(entity_id(hass, entry, ALEX["id"], "last_workout"))
    assert last.state == "2026-10-21T17:52:00+00:00"
    assert last.attributes["device_class"] == "timestamp"
    assert last.attributes["routine_name"] == "Push A"
    assert last.attributes["duration_min"] == 52
    assert last.attributes["date"] == "2026-10-21"

    assert hass.states.get(entity_id(hass, entry, ALEX["id"], "workouts_this_week")).state == "3"
    assert hass.states.get(entity_id(hass, entry, ALEX["id"], "workouts_7d")).state == "4"
    today = hass.states.get(entity_id(hass, entry, ALEX["id"], "today_routine"))
    assert today.state == "Pull B"
    assert today.attributes["rest_day"] is False


async def test_lb_profile_reports_in_lb(hass, aioclient_mock):
    entry = await setup_entry(hass, aioclient_mock)

    weight = hass.states.get(entity_id(hass, entry, SAM["id"], "body_weight"))
    assert weight.state == "176.4"
    assert weight.attributes["unit_of_measurement"] == "lb"
    today = hass.states.get(entity_id(hass, entry, SAM["id"], "today_routine"))
    assert today.state == "Rest day"
    assert today.attributes["rest_day"] is True


async def test_profile_without_data_has_unknown_values_not_invented_ones(hass, aioclient_mock):
    entry = await setup_entry(hass, aioclient_mock)

    weight = hass.states.get(entity_id(hass, entry, NOVA["id"], "body_weight"))
    assert weight.state == STATE_UNKNOWN
    assert weight.attributes["unit_of_measurement"] == "kg"
    assert weight.attributes["date"] is None
    last = hass.states.get(entity_id(hass, entry, NOVA["id"], "last_workout"))
    assert last.state == STATE_UNKNOWN
    assert last.attributes["routine_name"] is None
    assert last.attributes["duration_min"] is None
    assert hass.states.get(entity_id(hass, entry, NOVA["id"], "workouts_this_week")).state == "0"
    assert hass.states.get(entity_id(hass, entry, NOVA["id"], "today_routine")).state == "Rest day"


async def test_null_routine_on_a_training_day_is_unknown(hass, aioclient_mock):
    profile = {
        **ALEX,
        "today": {
            "date": "2026-10-22",
            "routine_id": None,
            "routine_name": None,
            "rest_day": False,
        },
    }
    entry = await setup_entry(hass, aioclient_mock, summary(profile))

    assert (
        hass.states.get(entity_id(hass, entry, ALEX["id"], "today_routine")).state == STATE_UNKNOWN
    )


async def test_new_profile_gets_entities_without_reload(hass, aioclient_mock):
    entry = await setup_entry(hass, aioclient_mock, summary(ALEX))
    assert len(er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)) == len(KEYS)

    aioclient_mock.clear_requests()
    aioclient_mock.get(SUMMARY_URL, json=summary(ALEX, SAM))
    await entry.runtime_data.async_refresh()
    await hass.async_block_till_done()

    assert len(er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)) == 2 * len(
        KEYS
    )
    assert hass.states.get(entity_id(hass, entry, SAM["id"], "body_weight")).state == "176.4"
    assert entry.state.value == "loaded"


async def test_profile_that_disappears_goes_unavailable(hass, aioclient_mock):
    entry = await setup_entry(hass, aioclient_mock, summary(ALEX, SAM))

    aioclient_mock.clear_requests()
    aioclient_mock.get(SUMMARY_URL, json=summary(ALEX))
    await entry.runtime_data.async_refresh()
    await hass.async_block_till_done()

    assert (
        hass.states.get(entity_id(hass, entry, SAM["id"], "body_weight")).state == STATE_UNAVAILABLE
    )
    assert hass.states.get(entity_id(hass, entry, ALEX["id"], "body_weight")).state == "80.2"


async def test_unload(hass, aioclient_mock):
    entry = await setup_entry(hass, aioclient_mock)

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()

    assert (
        hass.states.get(entity_id(hass, entry, ALEX["id"], "body_weight")).state
        == STATE_UNAVAILABLE
    )
    # Services belong to the integration and stay registered.
    assert hass.services.has_service(DOMAIN, "log_body_weight")
