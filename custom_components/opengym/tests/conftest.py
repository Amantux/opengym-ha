"""Shared fixtures for the openGym integration tests.

Runs under pytest-homeassistant-custom-component (a real Home Assistant test
environment) in its own venv — see requirements_test*.txt. Run from the repo
root:  .venv-ha/bin/python -m pytest custom_components/opengym/tests -q -o asyncio_mode=auto
"""

from __future__ import annotations

import os
import sys

import pytest

# Put the repo root on sys.path so `custom_components.opengym` imports when
# pytest is pointed straight at this nested directory.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")))


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Load the custom `opengym` component in every test."""
    yield
