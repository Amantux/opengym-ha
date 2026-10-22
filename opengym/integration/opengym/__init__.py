"""The openGym integration: sensors, events and services for an openGym add-on."""

from __future__ import annotations

from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from .const import CONF_HOST, CONF_PORT, CONF_TOKEN, DOMAIN
from .coordinator import OpenGymClient, OpenGymConfigEntry, OpenGymCoordinator
from .services import async_setup_services

PLATFORMS = [Platform.SENSOR]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    # Services belong to the integration, not to an entry: they stay
    # registered (and answer "not loaded") while entries reload.
    async_setup_services(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: OpenGymConfigEntry) -> bool:
    client = OpenGymClient(
        async_get_clientsession(hass),
        entry.data[CONF_HOST],
        int(entry.data[CONF_PORT]),
        entry.data[CONF_TOKEN],
    )
    coordinator = OpenGymCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: OpenGymConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
