"""opengym.log_body_weight / opengym.get_summary through real service calls.

Only HTTP is mocked. The guards that matter most:
  * an ambiguous or unknown profile name writes NOTHING (a weigh-in on the
    wrong person's profile is a silent mistake) and the error lists the
    candidates so the caller can fix the call;
  * a gateway error becomes one of our own messages — its body never reaches
    the caller, whatever it contains;
  * `date` is always sent, and "today" is today in Home Assistant's time zone.
"""

from __future__ import annotations

import copy
import json
import os

import pytest
import voluptuous as vol
import yaml
from aiohttp import ClientError
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.util.unit_system import US_CUSTOMARY_SYSTEM
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.opengym.const import CONF_HOST, CONF_PORT, CONF_TOKEN, DOMAIN
from custom_components.opengym.tests.common import (
    ALEX,
    BASE,
    NOVA,
    SAM,
    SUMMARY_URL,
    TOKEN,
    bodyweight_url,
    calls,
    setup_entry,
    summary,
)

HERE = os.path.dirname(__file__)
SERVICES_YAML = os.path.join(HERE, "..", "services.yaml")
OK_RESPONSE = {
    "profile_id": ALEX["id"],
    "entry": {"date": "2026-10-22", "value": 79.8, "unit": "kg"},
    "rev": 43,
}
LEAK = "SECRET-UPSTREAM-DETAIL /data/opengym/db.json"


async def _log(hass, **data):
    return await hass.services.async_call(
        DOMAIN, "log_body_weight", data, blocking=True, return_response=True
    )


def _posted(aioclient_mock) -> list:
    return calls(aioclient_mock, "post", "/bodyweight")


# --- registration ----------------------------------------------------------


async def test_documented_services_match_registered_services(hass, aioclient_mock):
    await setup_entry(hass, aioclient_mock)
    with open(SERVICES_YAML) as fh:
        documented = set(yaml.safe_load(fh))
    registered = set(hass.services.async_services().get(DOMAIN, {}))

    assert documented == registered == {"log_body_weight", "get_summary"}


def test_translations_mirror_strings_json():
    """Custom integrations load translations/en.json; strings.json is the source."""
    with (
        open(os.path.join(HERE, "..", "strings.json")) as a,
        open(os.path.join(HERE, "..", "translations", "en.json")) as b,
    ):
        assert json.load(a) == json.load(b)


# --- profile resolution ----------------------------------------------------


async def test_resolves_by_exact_id(hass, aioclient_mock):
    await setup_entry(hass, aioclient_mock)
    aioclient_mock.post(bodyweight_url(ALEX["id"]), json=OK_RESPONSE)

    await _log(hass, profile=ALEX["id"], weight=79.8, unit="kg", date="2026-10-22")

    assert len(_posted(aioclient_mock)) == 1


async def test_resolves_by_name_case_insensitively(hass, aioclient_mock):
    await setup_entry(hass, aioclient_mock)
    aioclient_mock.post(bodyweight_url(ALEX["id"]), json=OK_RESPONSE)

    result = await _log(hass, profile="  aLeX ", weight=79.8, unit="kg", date="2026-10-22")

    assert result["profile_id"] == ALEX["id"]
    [(_, url, _, _)] = _posted(aioclient_mock)
    assert str(url).endswith(f"/ha/v1/profiles/{ALEX['id']}/bodyweight")


async def test_profile_id_is_path_quoted(hass, aioclient_mock):
    """An id can never address another gateway route, whatever it contains."""
    odd = {**copy.deepcopy(ALEX), "id": "x/../../health"}
    await setup_entry(hass, aioclient_mock, summary(odd))
    aioclient_mock.post(f"{BASE}/ha/v1/profiles/x%2F..%2F..%2Fhealth/bodyweight", json=OK_RESPONSE)

    await _log(hass, profile="Alex", weight=80, unit="kg", date="2026-10-22")

    [(_, url, _, _)] = _posted(aioclient_mock)
    assert url.raw_path == "/ha/v1/profiles/x%2F..%2F..%2Fhealth/bodyweight"


async def test_ambiguous_name_refuses_lists_candidates_and_writes_nothing(hass, aioclient_mock):
    twin = {**copy.deepcopy(SAM), "id": "alexTwin00000004", "name": "ALEX"}
    await setup_entry(hass, aioclient_mock, summary(ALEX, twin))
    # Mocked so a regression that DOES write is caught by the count below.
    aioclient_mock.post(bodyweight_url(ALEX["id"]), json=OK_RESPONSE)
    aioclient_mock.post(bodyweight_url(twin["id"]), json=OK_RESPONSE)

    with pytest.raises(ServiceValidationError) as err:
        await _log(hass, profile="alex", weight=80, unit="kg")

    assert err.value.translation_key == "ambiguous_profile"
    message = str(err.value)
    assert f"Alex ({ALEX['id']})" in message
    assert f"ALEX ({twin['id']})" in message
    assert _posted(aioclient_mock) == []


async def test_unknown_profile_refuses_and_lists_every_profile(hass, aioclient_mock):
    await setup_entry(hass, aioclient_mock)
    aioclient_mock.post(bodyweight_url(ALEX["id"]), json=OK_RESPONSE)

    with pytest.raises(ServiceValidationError) as err:
        await _log(hass, profile="Al", weight=80, unit="kg")

    assert err.value.translation_key == "unknown_profile"
    message = str(err.value)
    for profile in (ALEX, SAM, NOVA):
        assert f"{profile['name']} ({profile['id']})" in message
    assert _posted(aioclient_mock) == []


# --- log_body_weight -------------------------------------------------------


async def test_log_body_weight_sends_payload_and_returns_the_stored_entry(hass, aioclient_mock):
    await setup_entry(hass, aioclient_mock)
    aioclient_mock.post(bodyweight_url(ALEX["id"]), json=OK_RESPONSE)
    polls_before = len(calls(aioclient_mock, "get", "/ha/v1/summary"))

    result = await _log(hass, profile="Alex", weight="79.8", unit="lb", date="2026-10-20")

    [(_, _, payload, headers)] = _posted(aioclient_mock)
    assert payload == {"weight": 79.8, "unit": "lb", "date": "2026-10-20"}
    assert headers["Authorization"] == f"Bearer {TOKEN}"
    assert result == {
        "profile_id": ALEX["id"],
        "profile_name": "Alex",
        "entry": {"date": "2026-10-22", "value": 79.8, "unit": "kg"},
        "rev": 43,
    }
    # The sensors are refreshed rather than waiting up to a minute.
    assert len(calls(aioclient_mock, "get", "/ha/v1/summary")) == polls_before + 1


async def test_date_defaults_to_today_in_home_assistant_time_zone(hass, aioclient_mock, freezer):
    # 12:30 UTC on the 22nd is already 01:30 on the 23rd in Auckland (NZDT).
    await hass.config.async_set_time_zone("Pacific/Auckland")
    freezer.move_to("2026-10-22T12:30:00+00:00")
    await setup_entry(hass, aioclient_mock)
    aioclient_mock.post(bodyweight_url(ALEX["id"]), json=OK_RESPONSE)

    await _log(hass, profile="Alex", weight=80, unit="kg")

    [(_, _, payload, _)] = _posted(aioclient_mock)
    assert payload["date"] == "2026-10-23"


async def test_omitting_unit_is_a_validation_error(hass, aioclient_mock):
    """The unit is never guessed.

    Home Assistant does not convert weight sensors to lb on a US customary
    system, so a kg scale there would otherwise be logged 2.2x too low.
    """
    hass.config.units = US_CUSTOMARY_SYSTEM
    await setup_entry(hass, aioclient_mock)
    aioclient_mock.post(bodyweight_url(ALEX["id"]), json=OK_RESPONSE)

    with pytest.raises(vol.Invalid) as err:
        await _log(hass, profile="Alex", weight=80, date="2026-10-22")

    assert "unit" in str(err.value)
    assert _posted(aioclient_mock) == []


async def test_without_return_response_still_writes(hass, aioclient_mock):
    await setup_entry(hass, aioclient_mock)
    aioclient_mock.post(bodyweight_url(ALEX["id"]), json=OK_RESPONSE)

    await hass.services.async_call(
        DOMAIN, "log_body_weight", {"profile": "Alex", "weight": 80, "unit": "kg"}, blocking=True
    )

    assert len(_posted(aioclient_mock)) == 1


@pytest.mark.parametrize("weight", [0, -1, "heavy"])
async def test_non_positive_or_non_numeric_weight_is_rejected_locally(hass, aioclient_mock, weight):
    await setup_entry(hass, aioclient_mock)

    with pytest.raises(vol.Invalid):
        await _log(hass, profile="Alex", weight=weight, unit="kg")

    assert _posted(aioclient_mock) == []


@pytest.mark.parametrize(
    ("response", "error_cls", "key"),
    [
        ({"status": 400, "json": {"error": LEAK}}, ServiceValidationError, "invalid_weigh_in"),
        ({"status": 404, "json": {"error": LEAK}}, ServiceValidationError, "profile_not_found"),
        ({"status": 409, "json": {"error": LEAK}}, HomeAssistantError, "profile_conflict"),
        ({"status": 401, "json": {"error": LEAK}}, HomeAssistantError, "invalid_auth"),
        ({"status": 413, "text": LEAK}, HomeAssistantError, "request_failed"),
        ({"status": 502, "json": {"error": LEAK}}, HomeAssistantError, "not_responding"),
        ({"status": 500, "text": LEAK}, HomeAssistantError, "not_responding"),
        ({"exc": TimeoutError()}, HomeAssistantError, "not_responding"),
        ({"exc": ClientError(LEAK)}, HomeAssistantError, "not_responding"),
        # 200 but not JSON: still ours, still no body.
        ({"text": LEAK}, HomeAssistantError, "not_responding"),
    ],
)
async def test_gateway_errors_map_to_our_messages_never_the_body(
    hass, aioclient_mock, response, error_cls, key
):
    await setup_entry(hass, aioclient_mock)
    aioclient_mock.post(bodyweight_url(ALEX["id"]), **response)

    with pytest.raises(error_cls) as err:
        await _log(hass, profile="Alex", weight=80, unit="kg", date="2026-10-22")

    assert err.value.translation_key == key
    message = str(err.value)
    assert message  # a real, translated sentence...
    assert message != key
    assert "SECRET" not in message  # ...that never carries the gateway's words
    assert "db.json" not in message


# --- which entry -----------------------------------------------------------


async def _second_entry(hass, aioclient_mock) -> MockConfigEntry:
    other = MockConfigEntry(
        domain=DOMAIN,
        unique_id="gym2.local:8099",
        data={CONF_HOST: "gym2.local", CONF_PORT: 8099, CONF_TOKEN: "t2"},
    )
    other.add_to_hass(hass)
    aioclient_mock.get("http://gym2.local:8099/ha/v1/summary", json=summary(SAM))
    assert await hass.config_entries.async_setup(other.entry_id)
    await hass.async_block_till_done()
    return other


async def test_several_entries_need_config_entry_id(hass, aioclient_mock):
    await setup_entry(hass, aioclient_mock, summary(ALEX))
    other = await _second_entry(hass, aioclient_mock)
    aioclient_mock.post(
        "http://gym2.local:8099/ha/v1/profiles/samId00000000002/bodyweight", json=OK_RESPONSE
    )

    with pytest.raises(ServiceValidationError) as err:
        await _log(hass, profile="Sam", weight=80, unit="kg")
    assert err.value.translation_key == "entry_required"

    await _log(hass, profile="Sam", weight=80, unit="kg", config_entry_id=other.entry_id)
    [(_, url, _, headers)] = _posted(aioclient_mock)
    assert url.host == "gym2.local"
    assert headers["Authorization"] == "Bearer t2"


async def test_unknown_config_entry_id(hass, aioclient_mock):
    await setup_entry(hass, aioclient_mock)

    with pytest.raises(ServiceValidationError) as err:
        await _log(hass, profile="Alex", weight=80, unit="kg", config_entry_id="nope")

    assert err.value.translation_key == "entry_not_found"


async def test_no_loaded_entry(hass, aioclient_mock):
    entry = await setup_entry(hass, aioclient_mock)
    assert await hass.config_entries.async_unload(entry.entry_id)

    with pytest.raises(ServiceValidationError) as err:
        await _log(hass, profile="Alex", weight=80, unit="kg")

    assert err.value.translation_key == "entry_not_loaded"


# --- get_summary -----------------------------------------------------------


async def test_get_summary_returns_every_profile(hass, aioclient_mock):
    await setup_entry(hass, aioclient_mock)

    result = await hass.services.async_call(
        DOMAIN, "get_summary", {}, blocking=True, return_response=True
    )

    assert result == {"profiles": [ALEX, SAM, NOVA]}


async def test_get_summary_filters_by_profile(hass, aioclient_mock):
    await setup_entry(hass, aioclient_mock)

    result = await hass.services.async_call(
        DOMAIN, "get_summary", {"profile": "sam"}, blocking=True, return_response=True
    )

    assert result == {"profiles": [SAM]}


async def test_get_summary_unknown_profile(hass, aioclient_mock):
    await setup_entry(hass, aioclient_mock)

    with pytest.raises(ServiceValidationError) as err:
        await hass.services.async_call(
            DOMAIN, "get_summary", {"profile": "nobody"}, blocking=True, return_response=True
        )

    assert err.value.translation_key == "unknown_profile"


async def test_get_summary_refuses_stale_data_during_an_outage(hass, aioclient_mock):
    entry = await setup_entry(hass, aioclient_mock)
    aioclient_mock.clear_requests()
    aioclient_mock.get(SUMMARY_URL, exc=ClientError("refused"))
    await entry.runtime_data.async_refresh()

    with pytest.raises(HomeAssistantError) as err:
        await hass.services.async_call(
            DOMAIN, "get_summary", {}, blocking=True, return_response=True
        )

    assert err.value.translation_key == "not_responding"
