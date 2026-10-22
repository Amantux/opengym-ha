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
    CONF_ADDON_SLUG,
    CONF_HOST,
    CONF_PORT,
    CONF_TOKEN,
    DOMAIN,
)
from custom_components.opengym.tests.common import (
    ADDON_SLUG,
    ALEX,
    HOST,
    PORT,
    SUMMARY_URL,
    TOKEN,
    calls,
    make_entry,
    setup_entry,
    summary,
)

USER_INPUT = {CONF_HOST: HOST, CONF_PORT: PORT, CONF_TOKEN: TOKEN}


def _discovery(
    token: str,
    host: str = HOST,
    port: int = PORT,
    name: str = "openGym",
    slug: str = ADDON_SLUG,
) -> HassioServiceInfo:
    return HassioServiceInfo(
        config={CONF_HOST: host, CONF_PORT: port, CONF_TOKEN: token},
        name=name,
        slug=slug,
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
    # Pinned to the add-on that announced it.
    assert result["data"] == {
        CONF_HOST: HOST,
        CONF_PORT: PORT,
        CONF_TOKEN: TOKEN,
        CONF_ADDON_SLUG: ADDON_SLUG,
    }
    assert result["result"].unique_id == ADDON_UNIQUE_ID


async def test_hassio_confirm_names_the_announcing_add_on(hass, aioclient_mock):
    """On a fresh install the user must be able to tell WHICH add-on is asking."""
    aioclient_mock.get("http://gym-tools:8099/ha/v1/summary", json=summary(ALEX))

    result = await _start_hassio(
        hass, TOKEN, host="gym-tools", name="Gym Tools", slug="0123abcd_gymtools"
    )

    assert result["step_id"] == "hassio_confirm"
    assert result["description_placeholders"] == {"addon": "Gym Tools", "slug": "0123abcd_gymtools"}


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
    assert entry.data == {
        CONF_HOST: HOST,
        CONF_PORT: PORT,
        CONF_TOKEN: "new-token",
        CONF_ADDON_SLUG: ADDON_SLUG,
    }
    assert len(hass.config_entries.async_entries(DOMAIN)) == 1
    # Already configured: no probe needed.
    assert aioclient_mock.call_count == 0


async def test_hassio_rediscovery_empty_token_keeps_stored_token(hass, aioclient_mock):
    entry = make_entry(hass, token="good-token")
    before = dict(entry.data)

    # Not even host/port move without a token: the stored one would go there.
    result = await _start_hassio(hass, "", host="elsewhere", port=1234)

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    assert entry.data == before
    assert aioclient_mock.call_count == 0


@pytest.mark.parametrize("token", ["", "attacker-token"])
async def test_hassio_foreign_add_on_changes_nothing_and_is_sent_nothing(
    hass, aioclient_mock, caplog, token
):
    """Any add-on can announce `opengym`. Only the one that created the entry counts.

    Without the pin, an announcement with an empty token re-points the entry at
    the announcer's host and the next poll hands it the stored token. A slug
    that merely ends in "_opengym" is another repository's add-on, not ours.
    """
    entry = await setup_entry(hass, aioclient_mock, summary(ALEX))
    before = dict(entry.data)
    aioclient_mock.get("http://evil-addon:9999/ha/v1/summary", json=summary(ALEX))
    requests = aioclient_mock.call_count

    result = await _start_hassio(
        hass, token, host="evil-addon", port=9999, slug="0123abcd_opengym"
    )
    await hass.async_block_till_done()

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "not_opengym_addon"
    assert result["description_placeholders"] == {"addon": "openGym", "slug": "0123abcd_opengym"}
    assert entry.data == before
    assert entry.state is config_entries.ConfigEntryState.LOADED
    assert aioclient_mock.call_count == requests  # no probe, no reload, nothing sent
    assert "0123abcd_opengym" in caplog.text


async def test_hassio_ignored_add_on_entry_stays_ignored(hass, aioclient_mock, caplog):
    ignored = MockConfigEntry(
        domain=DOMAIN, unique_id=ADDON_UNIQUE_ID, source=config_entries.SOURCE_IGNORE, data={}
    )
    ignored.add_to_hass(hass)

    result = await _start_hassio(hass, TOKEN)

    assert result["reason"] == "already_configured"
    assert ignored.data == {}
    assert aioclient_mock.call_count == 0
    assert "Ignored an openGym announcement" not in caplog.text


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
    aioclient_mock.get(SUMMARY_URL, json=summary(ALEX))

    result = await _start_hassio(hass, "minted")

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    assert manual.data[CONF_TOKEN] == "minted"
    assert manual.unique_id == f"{HOST}:{PORT}"  # not re-keyed
    assert len(hass.config_entries.async_entries(DOMAIN)) == 1
    # Checked against the entry's own address before it was stored.
    [(_, url, _, headers)] = aioclient_mock.mock_calls
    assert str(url) == SUMMARY_URL
    assert headers["Authorization"] == "Bearer minted"


async def test_hassio_fold_refuses_a_token_the_gateway_rejects(hass, aioclient_mock):
    """A manual entry is pinned to no add-on: any add-on can claim its address.

    So the advertised token is stored only if openGym there accepts it; a
    foreign add-on cannot swap in a token of its own.
    """
    manual = MockConfigEntry(
        domain=DOMAIN,
        unique_id=f"{HOST}:{PORT}",
        data={CONF_HOST: HOST, CONF_PORT: PORT, CONF_TOKEN: "good"},
    )
    manual.add_to_hass(hass)
    aioclient_mock.get(SUMMARY_URL, status=401)

    result = await _start_hassio(hass, "bogus", slug="0123abcd_evil")

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "invalid_auth"
    assert manual.data[CONF_TOKEN] == "good"


async def test_hassio_fold_with_empty_token_keeps_manual_token(hass, aioclient_mock):
    manual = MockConfigEntry(
        domain=DOMAIN,
        unique_id=f"{HOST}:{PORT}",
        data={CONF_HOST: HOST, CONF_PORT: PORT, CONF_TOKEN: "good"},
    )
    manual.add_to_hass(hass)

    result = await _start_hassio(hass, "")

    assert result["reason"] == "already_configured"
    assert manual.data[CONF_TOKEN] == "good"
    assert aioclient_mock.call_count == 0


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
    assert entry.data == {
        CONF_HOST: HOST,
        CONF_PORT: PORT,
        CONF_TOKEN: "fresh-token",
        CONF_ADDON_SLUG: ADDON_SLUG,
    }
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
