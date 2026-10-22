"""Diagnostics: downloadable by the user, so the token must never be in it."""

from __future__ import annotations

from homeassistant.setup import async_setup_component

from custom_components.opengym.const import CONF_HOST, CONF_PORT, CONF_TOKEN
from custom_components.opengym.tests.common import (
    ALEX,
    HOST,
    PORT,
    TOKEN,
    setup_entry,
    summary,
)


async def test_diagnostics_redacts_the_token(hass, aioclient_mock, hass_client):
    entry = await setup_entry(hass, aioclient_mock, summary(ALEX))
    assert await async_setup_component(hass, "diagnostics", {})
    client = await hass_client()

    response = await client.get(f"/api/diagnostics/config_entry/{entry.entry_id}")
    assert response.status == 200
    body = await response.text()
    data = (await response.json())["data"]

    assert TOKEN not in body
    assert data["entry"] == {CONF_HOST: HOST, CONF_PORT: PORT, CONF_TOKEN: "**REDACTED**"}
    assert data["profiles"] == {ALEX["id"]: ALEX}
    assert data["last_update_success"] is True
