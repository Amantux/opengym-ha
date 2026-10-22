"""Config flow: Supervisor discovery (+ confirm), manual setup, and reauth."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

import voluptuous as vol
from homeassistant.components import persistent_notification
from homeassistant.config_entries import (
    SOURCE_IGNORE,
    SOURCE_REAUTH,
    ConfigEntry,
    ConfigEntryState,
    ConfigFlow,
    ConfigFlowResult,
)
from homeassistant.core import DOMAIN as HOMEASSISTANT_DOMAIN
from homeassistant.core import callback
from homeassistant.helpers import issue_registry as ir
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
    CONF_ADDON_SLUG,
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
# Home Assistant 2024.11's global "Integration requires reconfiguration"
# notification (config_entries.RECONFIGURE_NOTIFICATION_ID; gone in newer cores).
_REAUTH_NOTIFICATION_ID = "config_entry_reconfigure"


def _target(data: Mapping[str, Any]) -> str:
    """The "host:port" an entry points at, case-folded like a hostname."""
    return f"{data.get(CONF_HOST, '')}:{data.get(CONF_PORT, '')}".lower()


class OpenGymConfigFlow(ConfigFlow, domain=DOMAIN):
    """Set up openGym from the add-on's discovery or by hand."""

    VERSION = 1

    def __init__(self) -> None:
        self._discovered: dict[str, Any] | None = None
        # The announcing add-on's name and slug, shown in the confirm dialog.
        self._addon: dict[str, str] = {}

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

    @callback
    def _async_update_and_reload(self, entry: ConfigEntry, updates: dict[str, Any]) -> bool:
        """Store `updates` in `entry`; if anything changed, set it up again with them.

        Home Assistant's own update-on-abort only reloads an entry that is
        loaded or retrying, so one whose setup failed on the rejected token
        (SETUP_ERROR) would keep the new token and stay down. And 2024.11's
        reload leaves the entry's reauth flow open, asking for a token nobody
        has to type any more, and aborting it there leaves its repair issue
        and notification behind (newer cores clear both with the flow).
        Returns whether the data changed.
        """
        if not self.hass.config_entries.async_update_entry(entry, data={**entry.data, **updates}):
            return False
        reauth = self.hass.config_entries.flow.async_progress_by_handler(
            DOMAIN, match_context={"entry_id": entry.entry_id, "source": SOURCE_REAUTH}
        )
        for flow in reauth:
            self.hass.config_entries.flow.async_abort(flow["flow_id"])
            ir.async_delete_issue(
                self.hass, HOMEASSISTANT_DOMAIN, f"config_entry_reauth_{DOMAIN}_{entry.entry_id}"
            )
        if reauth and not any(
            flow["context"]["source"] == SOURCE_REAUTH
            for flow in self.hass.config_entries.flow.async_progress()
        ):
            persistent_notification.async_dismiss(self.hass, _REAUTH_NOTIFICATION_ID)
        if entry.state in (
            ConfigEntryState.LOADED,
            ConfigEntryState.SETUP_RETRY,
            ConfigEntryState.SETUP_ERROR,
        ):
            self.hass.config_entries.async_schedule_reload(entry.entry_id)
        return True

    # ------------------------------------------------------------------
    # Supervisor discovery — the add-on advertises host, port and token.
    # ------------------------------------------------------------------
    async def async_step_hassio(self, discovery_info: HassioServiceInfo) -> ConfigFlowResult:
        config = discovery_info.config
        host = str(config[CONF_HOST])
        port = int(config.get(CONF_PORT, DEFAULT_PORT))
        token = str(config.get(CONF_TOKEN) or "")
        self._addon = {"addon": discovery_info.name, "slug": discovery_info.slug}

        # First without raise_on_progress: on HA 2024.11 an open REAUTH flow
        # for the add-on entry carries the same unique id, and the default
        # check would abort this rediscovery as "already_in_progress" — the
        # one flow that can deliver the token the reauth is waiting for.
        # (Newer cores skip reauth flows in that check themselves.)
        entry = await self.async_set_unique_id(ADDON_UNIQUE_ID, raise_on_progress=False)

        if entry is not None and entry.source != SOURCE_IGNORE:
            # Any add-on can list `discovery: [opengym]` and announce itself
            # here. The entry belongs to the add-on whose discovery created it:
            # an announcement from any other add-on changes nothing and is sent
            # nothing (it would otherwise re-point the entry at its own host
            # and be handed the stored token on the next poll).
            if entry.data.get(CONF_ADDON_SLUG) != discovery_info.slug:
                _LOGGER.warning(
                    "Ignored an openGym announcement from the add-on %r: openGym is set "
                    "up from the add-on %r. If you reinstalled openGym from another "
                    "repository, delete the openGym integration and add it again",
                    discovery_info.slug,
                    entry.data.get(CONF_ADDON_SLUG),
                )
                return self.async_abort(
                    reason="not_opengym_addon", description_placeholders=self._addon
                )
            # Re-point host/port only together with a token from the same
            # announcement, so the stored token never goes to a new address;
            # one carrying "" changes nothing (and never wipes a working token).
            if token and self._async_update_and_reload(
                entry, {CONF_HOST: host, CONF_PORT: port, CONF_TOKEN: token}
            ):
                return self.async_abort(reason="already_configured")
        # Nothing changed (or the entry is ignored): abort. A retrying entry is
        # retried now, since its add-on just announced that it is up.
        self._abort_if_unique_id_configured()

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
            if token and token != entry.data.get(CONF_TOKEN):
                # A manual entry belongs to no add-on, so any add-on can claim
                # its address. Store the advertised token only once openGym at
                # that address (the user's own, not a new one) accepts it.
                if error := await self._async_validate(host, port, token):
                    return self.async_abort(reason=error)
                self._async_update_and_reload(entry, {CONF_TOKEN: token})
            return self.async_abort(reason="already_configured")

        # Probe before offering, so a stopped add-on cannot create a dead entry.
        if error := await self._async_validate(host, port, token):
            return self.async_abort(reason=error)
        self._discovered = {
            CONF_HOST: host,
            CONF_PORT: port,
            CONF_TOKEN: token,
            CONF_ADDON_SLUG: discovery_info.slug,
        }
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
            description_placeholders=self._addon,
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
