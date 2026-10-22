"""Config flow: Supervisor discovery (+ confirm), manual setup, and reauth."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntryState,
    ConfigFlow,
    ConfigFlowResult,
)
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from .const import (
    ADDON_UNIQUE_ID,
    CONF_HOST,
    CONF_PORT,
    CONF_TOKEN,
    DEFAULT_PORT,
    DOMAIN,
)
from .coordinator import OpenGymAuthError, OpenGymClient, OpenGymError, base_url

_LOGGER = logging.getLogger(__name__)

_TOKEN_SELECTOR = TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD))
USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_HOST): TextSelector(),
        vol.Required(CONF_PORT, default=DEFAULT_PORT): NumberSelector(
            NumberSelectorConfig(min=1, max=65535, step=1, mode=NumberSelectorMode.BOX)
        ),
        vol.Required(CONF_TOKEN): _TOKEN_SELECTOR,
    }
)
REAUTH_SCHEMA = vol.Schema({vol.Required(CONF_TOKEN): _TOKEN_SELECTOR})


def _target(data: Mapping[str, Any]) -> str:
    """The "host:port" an entry points at, case-folded like a hostname."""
    return f"{data.get(CONF_HOST, '')}:{data.get(CONF_PORT, '')}".lower()


class OpenGymConfigFlow(ConfigFlow, domain=DOMAIN):
    """Set up openGym from the add-on's discovery or by hand."""

    VERSION = 1

    def __init__(self) -> None:
        self._discovered: dict[str, Any] | None = None

    async def _async_validate(self, host: str, port: int, token: str) -> str | None:
        """Probe the authenticated summary; return a translated error key or None.

        The summary (not /health) so a wrong token fails here, at setup, rather
        than as an entry that silently never loads.
        """
        client = OpenGymClient(async_get_clientsession(self.hass), host, port, token)
        try:
            await client.async_get_summary()
        except OpenGymAuthError:
            return "invalid_auth"
        except OpenGymError as err:
            _LOGGER.debug("openGym at %s:%s did not answer the probe: %s", host, port, err)
            return "cannot_connect"
        return None

    # ------------------------------------------------------------------
    # Supervisor discovery — the add-on advertises host, port and token.
    # ------------------------------------------------------------------
    async def async_step_hassio(self, discovery_info: HassioServiceInfo) -> ConfigFlowResult:
        config = discovery_info.config
        host = str(config[CONF_HOST])
        port = int(config.get(CONF_PORT, DEFAULT_PORT))
        token = str(config.get(CONF_TOKEN) or "")

        # First without raise_on_progress: on HA 2024.11 an open REAUTH flow
        # for the add-on entry carries the same unique id, and the default
        # check would abort this rediscovery as "already_in_progress" — the
        # one flow that can deliver the token the reauth is waiting for.
        # (Newer cores skip reauth flows in that check themselves.)
        await self.async_set_unique_id(ADDON_UNIQUE_ID, raise_on_progress=False)

        # Refresh host/port, and the token ONLY when one was advertised: a
        # re-fired discovery carrying "" must never wipe a working token.
        # Reloads the entry when its data changed (if loaded or retrying).
        updates: dict[str, Any] = {CONF_HOST: host, CONF_PORT: port}
        if token:
            updates[CONF_TOKEN] = token
        self._abort_if_unique_id_configured(updates=updates)

        # No add-on entry yet: now refuse a second concurrent discovery flow.
        await self.async_set_unique_id(ADDON_UNIQUE_ID)

        # A manual entry for the same host:port would otherwise be duplicated
        # by this discovered one. Fold the discovery into it instead (same
        # empty-token rule) and abort; its unique id is left alone. A manual
        # entry made by IP will not match the advertised hostname — the
        # confirm text tells the user to remove it.
        discovered = f"{host}:{port}".lower()
        for entry in self._async_current_entries(include_ignore=False):
            if _target(entry.data) != discovered:
                continue
            if (
                token
                and self.hass.config_entries.async_update_entry(
                    entry, data={**entry.data, CONF_TOKEN: token}
                )
                and entry.state in (ConfigEntryState.LOADED, ConfigEntryState.SETUP_RETRY)
            ):
                self.hass.config_entries.async_schedule_reload(entry.entry_id)
            return self.async_abort(reason="already_configured")

        # Probe before offering, so a stopped add-on cannot create a dead entry.
        if error := await self._async_validate(host, port, token):
            return self.async_abort(reason=error)
        self._discovered = {CONF_HOST: host, CONF_PORT: port, CONF_TOKEN: token}
        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        assert self._discovered is not None
        if user_input is not None:
            return self.async_create_entry(title="openGym", data=self._discovered)
        self._set_confirm_only()
        return self.async_show_form(
            step_id="hassio_confirm",
            description_placeholders={"addon": "openGym"},
        )

    # ------------------------------------------------------------------
    # Manual setup
    # ------------------------------------------------------------------
    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            # Hostnames are case-insensitive; lowercasing keeps the unique id
            # (and the rediscovery fold above) from splitting on case.
            host = str(user_input[CONF_HOST]).strip().lower()
            port = int(user_input[CONF_PORT])
            token = str(user_input[CONF_TOKEN]).strip()
            try:
                base_url(host, port)
            except ValueError:
                errors[CONF_HOST] = "invalid_host"
            else:
                await self.async_set_unique_id(f"{host}:{port}")
                self._abort_if_unique_id_configured()
                # The discovered add-on entry has a different unique id, so
                # match on what it points at: the same gateway twice would
                # duplicate every device and force config_entry_id on services.
                for entry in self._async_current_entries(include_ignore=False):
                    if _target(entry.data) == f"{host}:{port}":
                        return self.async_abort(reason="already_configured")
                if error := await self._async_validate(host, port, token):
                    errors["base"] = error
                else:
                    return self.async_create_entry(
                        title="openGym",
                        data={CONF_HOST: host, CONF_PORT: port, CONF_TOKEN: token},
                    )
        return self.async_show_form(
            step_id="user",
            data_schema=self.add_suggested_values_to_schema(USER_SCHEMA, user_input),
            errors=errors,
        )

    # ------------------------------------------------------------------
    # Reauth — the stored token was rejected.
    # ------------------------------------------------------------------
    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            token = str(user_input[CONF_TOKEN]).strip()
            error = await self._async_validate(
                entry.data[CONF_HOST], int(entry.data[CONF_PORT]), token
            )
            if error is None:
                return self.async_update_reload_and_abort(entry, data_updates={CONF_TOKEN: token})
            errors["base"] = error
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=REAUTH_SCHEMA,
            errors=errors,
            description_placeholders={"host": f"{entry.data[CONF_HOST]}:{entry.data[CONF_PORT]}"},
        )
