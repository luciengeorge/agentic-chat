import importlib
import sys

import httpx
import pytest

from ac_core import logging, tracing
from ac_core.settings import Settings
from ac_fake_workspace.app import create_app


async def test_health() -> None:
    transport = httpx.ASGITransport(create_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://fw") as client:
        response = await client.get("/health")
    assert response.json() == {"status": "ok", "service": "fake-workspace"}


def test_entry_point_configures_tracing(monkeypatch: pytest.MonkeyPatch) -> None:
    configured: list[str] = []

    def configure_tracing(service: str, settings: Settings) -> None:
        configured.append(service)

    def configure_logging(service: str) -> None:
        pass

    monkeypatch.setattr(tracing, "configure_tracing", configure_tracing)
    monkeypatch.setattr(logging, "configure_logging", configure_logging)
    monkeypatch.delitem(sys.modules, "ac_fake_workspace.main", raising=False)
    importlib.import_module("ac_fake_workspace.main")
    assert configured == ["fake-workspace"]
