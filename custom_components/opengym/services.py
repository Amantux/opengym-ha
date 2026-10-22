"""opengym.log_body_weight and opengym.get_summary.

Registered once in async_setup (they outlive any single entry). Every error a
caller sees is one of our translated messages; a gateway response body is
never shown, whatever it says.
"""

from __future__ import annotations

from typing import Any, NoReturn

import voluptuous as vol
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import UnitOfMass
from homeassistant.core import (
    HomeAssistant,
    ServiceCall,
    ServiceResponse,
    SupportsResponse,
    callback,
)
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.util import dt as dt_util

from .const import (
    ATTR_CONFIG_ENTRY_ID,
    ATTR_DATE,
    ATTR_PROFILE,
    ATTR_UNIT,
    ATTR_WEIGHT,
    DOMAIN,
    SERVICE_GET_SUMMARY,
    SERVICE_LOG_BODY_WEIGHT,
    UNIT_KG,
    UNIT_LB,
)
from .coordinator import (
    OpenGymAuthError,
    OpenGymConfigEntry,
    OpenGymCoordinator,
    OpenGymError,
    OpenGymResponseError,
)

LOG_BODY_WEIGHT_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_PROFILE): cv.string,
        # Only "a positive number" here; the gateway owns the real limits
        # (≤ 700 kg-equivalent) and answers 400, mapped below.
        vol.Required(ATTR_WEIGHT): vol.All(vol.Coerce(float), vol.Range(min=0, min_included=False)),
        vol.Optional(ATTR_UNIT): vol.In([UNIT_KG, UNIT_LB]),
        vol.Optional(ATTR_DATE): cv.date,
        vol.Optional(ATTR_CONFIG_ENTRY_ID): cv.string,
    }
)
GET_SUMMARY_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_PROFILE): cv.string,
        vol.Optional(ATTR_CONFIG_ENTRY_ID): cv.string,
    }
)


def _error(
    key: str, cls: type[HomeAssistantError] = HomeAssistantError, **placeholders: str
) -> NoReturn:
    raise cls(
        translation_domain=DOMAIN,
        translation_key=key,
        translation_placeholders=placeholders or None,
    )


def _coordinator(hass: HomeAssistant, call: ServiceCall) -> OpenGymCoordinator:
    """The entry the call targets: the given one, else the only loaded one."""
    if entry_id := call.data.get(ATTR_CONFIG_ENTRY_ID):
        entry: OpenGymConfigEntry | None = hass.config_entries.async_get_entry(entry_id)
        if entry is None or entry.domain != DOMAIN:
            _error("entry_not_found", ServiceValidationError, entry_id=entry_id)
        if entry.state is not ConfigEntryState.LOADED:
            _error("entry_not_loaded", ServiceValidationError)
        return entry.runtime_data
    loaded = [
        entry
        for entry in hass.config_entries.async_entries(DOMAIN)
        if entry.state is ConfigEntryState.LOADED
    ]
    if not loaded:
        _error("entry_not_loaded", ServiceValidationError)
    if len(loaded) > 1:
        _error("entry_required", ServiceValidationError)
    return loaded[0].runtime_data


def _label(profile: dict[str, Any]) -> str:
    return f"{profile.get('name')} ({profile.get('id')})"


def resolve_profile(profiles: dict[str, dict[str, Any]], ident: str) -> dict[str, Any]:
    """Exact id, else a unique case-insensitive name — never a guess.

    Two profiles with the same name refuse rather than pick one: logging a
    weigh-in on the wrong person's profile is a silent mistake.
    """
    ident = ident.strip()
    if ident in profiles:
        return profiles[ident]
    wanted = ident.casefold()
    matches = [p for p in profiles.values() if str(p.get("name") or "").casefold() == wanted]
    if len(matches) == 1:
        return matches[0]
    if matches:
        _error(
            "ambiguous_profile",
            ServiceValidationError,
            profile=ident,
            candidates=", ".join(sorted(_label(p) for p in matches)),
        )
    _error(
        "unknown_profile",
        ServiceValidationError,
        profile=ident,
        candidates=", ".join(sorted(_label(p) for p in profiles.values())) or "-",
    )


def _raise_for_write_error(err: OpenGymError, name: str) -> NoReturn:
    """Map a failed write to our own message (the body is never read)."""
    if isinstance(err, OpenGymAuthError):
        _error("invalid_auth")
    if isinstance(err, OpenGymResponseError):
        if err.status == 400:
            _error("invalid_weigh_in", ServiceValidationError)
        if err.status == 404:
            _error("profile_not_found", ServiceValidationError, profile=name)
        if err.status == 409:
            _error("profile_conflict", profile=name)
        if err.status < 500:
            _error("request_failed", status=str(err.status))
    # 5xx (the gateway's 502 included), timeouts, refused connections.
    _error("not_responding")


def _default_unit(hass: HomeAssistant) -> str:
    return UNIT_LB if hass.config.units.mass_unit == UnitOfMass.POUNDS else UNIT_KG


async def _async_log_body_weight(hass: HomeAssistant, call: ServiceCall) -> ServiceResponse:
    coordinator = _coordinator(hass, call)
    profile = resolve_profile(coordinator.data, call.data[ATTR_PROFILE])
    name = str(profile.get("name") or profile["id"])
    # Always sent: "today" is Home Assistant's today (dt_util.now() is in the
    # configured time zone), not whatever day it already is on the gateway.
    day = call.data.get(ATTR_DATE) or dt_util.now().date()
    payload = {
        "weight": call.data[ATTR_WEIGHT],
        "unit": call.data.get(ATTR_UNIT) or _default_unit(hass),
        "date": day.isoformat(),
    }
    try:
        result = await coordinator.client.async_log_body_weight(profile["id"], payload)
    except OpenGymError as err:
        _raise_for_write_error(err, name)

    await coordinator.async_request_refresh()
    if not call.return_response:
        return None
    entry = result.get("entry") if isinstance(result.get("entry"), dict) else {}
    return {
        "profile_id": profile["id"],
        "profile_name": name,
        "entry": {key: entry.get(key) for key in ("date", "value", "unit")},
        "rev": result.get("rev"),
    }


async def _async_get_summary(hass: HomeAssistant, call: ServiceCall) -> ServiceResponse:
    coordinator = _coordinator(hass, call)
    if not coordinator.last_update_success:
        # Serving the last good poll as if it were current would hide an outage.
        _error("not_responding")
    profiles = list(coordinator.data.values())
    if ATTR_PROFILE in call.data:
        profiles = [resolve_profile(coordinator.data, call.data[ATTR_PROFILE])]
    return {"profiles": profiles}


@callback
def async_setup_services(hass: HomeAssistant) -> None:
    async def log_body_weight(call: ServiceCall) -> ServiceResponse:
        return await _async_log_body_weight(hass, call)

    async def get_summary(call: ServiceCall) -> ServiceResponse:
        return await _async_get_summary(hass, call)

    hass.services.async_register(
        DOMAIN,
        SERVICE_LOG_BODY_WEIGHT,
        log_body_weight,
        schema=LOG_BODY_WEIGHT_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_GET_SUMMARY,
        get_summary,
        schema=GET_SUMMARY_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )
