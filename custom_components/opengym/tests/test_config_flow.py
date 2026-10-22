"""Config flow: manual setup, Supervisor discovery (+ confirm), reauth.

Probes go through the real client with only HTTP mocked, so a status mapping
regression (401 -> invalid_auth, network -> cannot_connect) fails here.
The add-on re-fires discovery on every boot, and a user may already have added
the same gateway by hand: either way the result must be ONE entry with a
current token, and an empty advertised token must never wipe a good one.
"""

from __future__ import annotations

import pytest
from aiohttp import ClientError
from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers.service_info.hassio import HassioServiceInfo
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.opengym.const import (
    ADDON_UNIQUE_ID,
    CONF_HOST,
    CONF_PORT,
    CONF_TOKEN,
    DOMAIN,
)
from custom_components.opengym.tests.common import (
    ALEX,
    HOST,
    PORT,
    SUMMARY_URL,
    TOKEN,
    calls,
    make_entry,
    summary,
)

USER_INPUT = {CONF_HOST: HOST, CONF_PORT: PORT, CONF_TOKEN: TOKEN}


def _discovery(token: str, host: str = HOST, port: int = PORT) -> HassioServiceInfo:
    return HassioServiceInfo(
        config={CONF_HOST: host, CONF_PORT: port, CONF_TOKEN: token},
        name="openGym",
        slug="opengym",
        uuid="1234",
    )


async def _start_hassio(hass, token: str, **kwargs):
    return await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_HASSIO}, data=_discovery(token, **kwargs)
    )


async def _user_flow(hass, user_input=USER_INPUT):
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"
    return await hass.config_entries.flow.async_configure(result["flow_id"], user_input)


# --- manual setup ----------------------------------------------------------


async def test_user_creates_entry_and_sends_bearer_token(hass, aioclient_mock):
    aioclient_mock.get(SUMMARY_URL, json=summary(ALEX))

    result = await _user_flow(hass, {**USER_INPUT, CONF_HOST: "  Local-OpenGym "})

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {CONF_HOST: HOST, CONF_PORT: PORT, CONF_TOKEN: TOKEN}
    assert result["result"].unique_id == f"{HOST}:{PORT}"
    probe = calls(aioclient_mock, "get", "/ha/v1/summary")[0]
    assert probe[3]["Authorization"] == f"Bearer {TOKEN}"


@pytest.mark.parametrize("status", [401, 403])
async def test_user_invalid_auth(hass, aioclient_mock, status):
    aioclient_mock.get(SUMMARY_URL, status=status, json={"error": "unauthorized"})

    result = await _user_flow(hass)

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_auth"}


@pytest.mark.parametrize(
    "response",
    [
        {"exc": ClientError("refused")},
        {"exc": TimeoutError()},
        {"status": 502, "json": {"error": "openGym is not responding"}},
        # A 200 from something that is not the gateway must not pass the probe.
        {"text": "<html>not openGym</html>"},
        {"json": {"ok": True}},
    ],
)
async def test_user_cannot_connect(hass, aioclient_mock, response):
    aioclient_mock.get(SUMMARY_URL, **response)

    result = await _user_flow(hass)

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}
    assert hass.config_entries.async_entries(DOMAIN) == []


async def test_user_recovers_after_an_error(hass, aioclient_mock):
    aioclient_mock.get(SUMMARY_URL, status=401)
    result = await _user_flow(hass)
    assert result["errors"] == {"base": "invalid_auth"}

    aioclient_mock.clear_requests()
    aioclient_mock.get(SUMMARY_URL, json=summary(ALEX))
    result = await hass.config_entries.flow.async_configure(result["flow_id"], USER_INPUT)

    assert result["type"] is FlowResultType.CREATE_ENTRY


async def test_user_rejects_a_url_as_host_without_probing(hass, aioclient_mock):
    result = await _user_flow(hass, {**USER_INPUT, CONF_HOST: "http://local-opengym"})

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {CONF_HOST: "invalid_host"}
    assert aioclient_mock.call_count == 0


async def test_user_already_configured(hass, aioclient_mock):
    make_entry(hass, unique_id=f"{HOST}:{PORT}")
    aioclient_mock.get(SUMMARY_URL, json=summary(ALEX))

    result = await _user_flow(hass)

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


async def test_user_refuses_the_gateway_the_add_on_entry_already_uses(hass, aioclient_mock):
    make_entry(hass)  # discovered add-on entry: unique id opengym_addon, same host:port
    aioclient_mock.get(SUMMARY_URL, json=summary(ALEX))

    result = await _user_flow(hass)

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    assert len(hass.config_entries.async_entries(DOMAIN)) == 1


# --- Supervisor discovery --------------------------------------------------


async def test_hassio_new_install_probes_then_confirms(hass, aioclient_mock):
    aioclient_mock.get(SUMMARY_URL, json=summary(ALEX))

    result = await _start_hassio(hass, TOKEN)

    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "hassio_confirm"
    # Probed with the advertised token before anything was offered.
    [(_, _, _, headers)] = calls(aioclient_mock, "get", "/ha/v1/summary")
    assert headers["Authorization"] == f"Bearer {TOKEN}"

    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {CONF_HOST: HOST, CONF_PORT: PORT, CONF_TOKEN: TOKEN}
    assert result["result"].unique_id == ADDON_UNIQUE_ID


async def test_hassio_unreachable_aborts(hass, aioclient_mock):
    aioclient_mock.get(SUMMARY_URL, exc=ClientError("refused"))

    result = await _start_hassio(hass, TOKEN)

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "cannot_connect"
    assert hass.config_entries.async_entries(DOMAIN) == []


async def test_hassio_rejected_token_aborts(hass, aioclient_mock):
    aioclient_mock.get(SUMMARY_URL, status=401)

    result = await _start_hassio(hass, TOKEN)

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "invalid_auth"


async def test_hassio_rediscovery_updates_token_and_host(hass, aioclient_mock):
    entry = make_entry(hass, token="old-token")
    entry_data_host = "old-hostname"
    hass.config_entries.async_update_entry(entry, data={**entry.data, CONF_HOST: entry_data_host})

    result = await _start_hassio(hass, "new-token")

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    assert entry.data == {CONF_HOST: HOST, CONF_PORT: PORT, CONF_TOKEN: "new-token"}
    assert len(hass.config_entries.async_entries(DOMAIN)) == 1
    # Already configured: no probe needed.
    assert aioclient_mock.call_count == 0


async def test_hassio_rediscovery_empty_token_keeps_stored_token(hass):
    entry = make_entry(hass, token="good-token")

    result = await _start_hassio(hass, "")

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    assert entry.data[CONF_TOKEN] == "good-token"


async def test_hassio_rediscovery_reloads_a_loaded_entry(hass, aioclient_mock):
    aioclient_mock.get(SUMMARY_URL, json=summary(ALEX))
    entry = make_entry(hass, token="old-token")
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    before = len(calls(aioclient_mock, "get", "/ha/v1/summary"))

    await _start_hassio(hass, "new-token")
    await hass.async_block_till_done()

    after = calls(aioclient_mock, "get", "/ha/v1/summary")
    assert len(after) == before + 1  # reloaded: polled again...
    assert after[-1][3]["Authorization"] == "Bearer new-token"  # ...with the new token
    assert entry.state is config_entries.ConfigEntryState.LOADED


async def test_hassio_rediscovery_updates_token_while_reauth_is_open(hass, aioclient_mock):
    """The token a reauth is waiting for arrives by rediscovery.

    On HA 2024.11 an open reauth flow carries the add-on's unique id, and the
    default in-progress check would abort the rediscovery before the token
    is stored.
    """
    entry = make_entry(hass, token="revoked-token")
    reauth = await entry.start_reauth_flow(hass)
    assert reauth["step_id"] == "reauth_confirm"

    result = await _start_hassio(hass, "new-token")

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    assert entry.data[CONF_TOKEN] == "new-token"


async def test_hassio_second_concurrent_discovery_aborts(hass, aioclient_mock):
    aioclient_mock.get(SUMMARY_URL, json=summary(ALEX))
    first = await _start_hassio(hass, TOKEN)
    assert first["step_id"] == "hassio_confirm"

    second = await _start_hassio(hass, TOKEN)

    assert second["type"] is FlowResultType.ABORT
    assert second["reason"] == "already_in_progress"


async def test_hassio_folds_into_manual_entry_for_same_host(hass, aioclient_mock):
    manual = MockConfigEntry(
        domain=DOMAIN,
        unique_id=f"{HOST}:{PORT}",
        data={CONF_HOST: HOST.upper(), CONF_PORT: PORT, CONF_TOKEN: "old"},
    )
    manual.add_to_hass(hass)

    result = await _start_hassio(hass, "minted")

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    assert manual.data[CONF_TOKEN] == "minted"
    assert manual.unique_id == f"{HOST}:{PORT}"  # not re-keyed
    assert len(hass.config_entries.async_entries(DOMAIN)) == 1
    assert aioclient_mock.call_count == 0


async def test_hassio_fold_with_empty_token_keeps_manual_token(hass):
    manual = MockConfigEntry(
        domain=DOMAIN,
        unique_id=f"{HOST}:{PORT}",
        data={CONF_HOST: HOST, CONF_PORT: PORT, CONF_TOKEN: "good"},
    )
    manual.add_to_hass(hass)

    result = await _start_hassio(hass, "")

    assert result["reason"] == "already_configured"
    assert manual.data[CONF_TOKEN] == "good"


async def test_hassio_does_not_fold_a_different_host(hass, aioclient_mock):
    MockConfigEntry(
        domain=DOMAIN,
        unique_id="192.168.1.5:8099",
        data={CONF_HOST: "192.168.1.5", CONF_PORT: PORT, CONF_TOKEN: "other"},
    ).add_to_hass(hass)
    aioclient_mock.get(SUMMARY_URL, json=summary(ALEX))

    result = await _start_hassio(hass, TOKEN)

    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "hassio_confirm"


# --- reauth ----------------------------------------------------------------


async def test_reauth_stores_new_token(hass, aioclient_mock):
    entry = make_entry(hass, token="revoked-token")
    aioclient_mock.get(SUMMARY_URL, json=summary(ALEX))

    result = await entry.start_reauth_flow(hass)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "reauth_confirm"
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_TOKEN: " fresh-token "}
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert entry.data == {CONF_HOST: HOST, CONF_PORT: PORT, CONF_TOKEN: "fresh-token"}
    probe = calls(aioclient_mock, "get", "/ha/v1/summary")[0]
    assert probe[3]["Authorization"] == "Bearer fresh-token"


async def test_reauth_rejected_token_shows_error(hass, aioclient_mock):
    entry = make_entry(hass, token="revoked-token")
    aioclient_mock.get(SUMMARY_URL, status=401)

    result = await entry.start_reauth_flow(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_TOKEN: "still-wrong"}
    )

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_auth"}
    assert entry.data[CONF_TOKEN] == "revoked-token"
