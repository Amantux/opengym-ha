"""Constants for the openGym integration (wire names follow docs/contract.md §7/§9)."""

from __future__ import annotations

from datetime import timedelta

DOMAIN = "opengym"

CONF_HOST = "host"
CONF_PORT = "port"
CONF_TOKEN = "token"

# The add-on's gateway port: ingress port and the integration's direct port.
DEFAULT_PORT = 8099
# Hassio-discovered entries share one fixed unique id, so a re-fired discovery
# (every add-on boot) updates the entry instead of offering a second one.
ADDON_UNIQUE_ID = "opengym_addon"

SCAN_INTERVAL = timedelta(seconds=60)

PATH_SUMMARY = "/ha/v1/summary"
PATH_BODYWEIGHT = "/ha/v1/profiles/{profile_id}/bodyweight"

EVENT_WORKOUT_COMPLETED = "opengym_workout_completed"

SERVICE_LOG_BODY_WEIGHT = "log_body_weight"
SERVICE_GET_SUMMARY = "get_summary"

ATTR_PROFILE = "profile"
ATTR_WEIGHT = "weight"
ATTR_UNIT = "unit"
ATTR_DATE = "date"
ATTR_CONFIG_ENTRY_ID = "config_entry_id"

UNIT_KG = "kg"
UNIT_LB = "lb"
