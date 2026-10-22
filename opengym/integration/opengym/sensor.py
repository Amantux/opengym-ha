"""Per-profile sensors from the openGym summary (contract §7)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.const import UnitOfMass
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.typing import StateType
from homeassistant.util import dt as dt_util

from .const import UNIT_LB
from .coordinator import OpenGymConfigEntry, OpenGymCoordinator
from .entity import OpenGymProfileEntity

# A state, not a label: routine names are free text, so this sensor cannot be
# an ENUM with translated states. Automations can use the rest_day attribute.
REST_DAY = "Rest day"


def _part(profile: dict[str, Any], key: str) -> dict[str, Any]:
    """A nested summary object, or {} when the gateway sent null."""
    value = profile.get(key)
    return value if isinstance(value, dict) else {}


def _timestamp(value: Any) -> datetime | None:
    parsed = dt_util.parse_datetime(value) if isinstance(value, str) else None
    # A timestamp sensor rejects a naive datetime; unknown beats a guessed zone.
    return parsed if parsed is not None and parsed.tzinfo is not None else None


def _weight_unit(profile: dict[str, Any]) -> str:
    unit = _part(profile, "body_weight").get("unit") or profile.get("unit")
    return UnitOfMass.POUNDS if unit == UNIT_LB else UnitOfMass.KILOGRAMS


def _today_routine(profile: dict[str, Any]) -> str | None:
    today = _part(profile, "today")
    if today.get("rest_day"):
        return REST_DAY
    return today.get("routine_name")


@dataclass(frozen=True, kw_only=True)
class OpenGymSensorDescription(SensorEntityDescription):
    value_fn: Callable[[dict[str, Any]], StateType | datetime]
    attrs_fn: Callable[[dict[str, Any]], dict[str, Any]] | None = None
    unit_fn: Callable[[dict[str, Any]], str] | None = None


SENSORS: tuple[OpenGymSensorDescription, ...] = (
    OpenGymSensorDescription(
        key="body_weight",
        translation_key="body_weight",
        device_class=SensorDeviceClass.WEIGHT,
        state_class=SensorStateClass.MEASUREMENT,
        suggested_display_precision=1,
        value_fn=lambda p: _part(p, "body_weight").get("value"),
        unit_fn=_weight_unit,
        attrs_fn=lambda p: {"date": _part(p, "body_weight").get("date")},
    ),
    OpenGymSensorDescription(
        key="last_workout",
        translation_key="last_workout",
        device_class=SensorDeviceClass.TIMESTAMP,
        value_fn=lambda p: _timestamp(_part(p, "last_workout").get("ended_at")),
        attrs_fn=lambda p: {
            key: _part(p, "last_workout").get(key)
            for key in ("routine_name", "duration_min", "date")
        },
    ),
    OpenGymSensorDescription(
        key="workouts_this_week",
        translation_key="workouts_this_week",
        icon="mdi:calendar-week",
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda p: p.get("workouts_this_week"),
    ),
    OpenGymSensorDescription(
        key="workouts_7d",
        translation_key="workouts_7d",
        icon="mdi:calendar-range",
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda p: p.get("workouts_7d"),
    ),
    OpenGymSensorDescription(
        key="today_routine",
        translation_key="today_routine",
        icon="mdi:dumbbell",
        value_fn=_today_routine,
        attrs_fn=lambda p: {
            "date": _part(p, "today").get("date"),
            "rest_day": _part(p, "today").get("rest_day"),
        },
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OpenGymConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator = entry.runtime_data
    known: set[str] = set()

    @callback
    def _add_new_profiles() -> None:
        # Runs now and after every refresh, so a profile created in openGym
        # later (a new household member opening it) gets entities without a
        # reload.
        new = [pid for pid in coordinator.data if pid not in known]
        if not new:
            return
        known.update(new)
        async_add_entities(
            OpenGymSensor(coordinator, pid, description) for pid in new for description in SENSORS
        )

    _add_new_profiles()
    entry.async_on_unload(coordinator.async_add_listener(_add_new_profiles))


class OpenGymSensor(OpenGymProfileEntity, SensorEntity):
    entity_description: OpenGymSensorDescription

    def __init__(
        self,
        coordinator: OpenGymCoordinator,
        profile_id: str,
        description: OpenGymSensorDescription,
    ) -> None:
        super().__init__(coordinator, profile_id, description.key)
        self.entity_description = description

    @property
    def native_value(self) -> StateType | datetime:
        return self.entity_description.value_fn(self.profile)

    @property
    def native_unit_of_measurement(self) -> str | None:
        if self.entity_description.unit_fn is not None:
            return self.entity_description.unit_fn(self.profile)
        return super().native_unit_of_measurement

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        if self.entity_description.attrs_fn is None:
            return None
        return self.entity_description.attrs_fn(self.profile)
