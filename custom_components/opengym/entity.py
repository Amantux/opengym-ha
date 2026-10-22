"""Base entity: one device per openGym profile."""

from __future__ import annotations

from typing import Any

from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import OpenGymCoordinator


class OpenGymProfileEntity(CoordinatorEntity[OpenGymCoordinator]):
    """An entity that reads one profile out of the coordinator's summary."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: OpenGymCoordinator, profile_id: str, key: str) -> None:
        super().__init__(coordinator)
        self._profile_id = profile_id
        # Scoped by entry so two entries that reach the same instance (say,
        # one by IP and one by hostname) never fight over one device.
        entry_id = coordinator.config_entry.entry_id
        self._attr_unique_id = f"{entry_id}_{profile_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, f"{entry_id}_{profile_id}")},
            name=coordinator.data[profile_id].get("name") or profile_id,
            manufacturer="openGym",
            model="Profile",
            entry_type=DeviceEntryType.SERVICE,
        )

    @property
    def profile(self) -> dict[str, Any]:
        return self.coordinator.data.get(self._profile_id) or {}

    @property
    def available(self) -> bool:
        # A profile that was disabled or deleted in openGym drops out of the
        # summary; its entities go unavailable rather than showing stale values.
        return super().available and self._profile_id in self.coordinator.data
