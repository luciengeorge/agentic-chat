import importlib
import sys
from pathlib import Path

import pytest

from ac_core import logging, tracing
from ac_core.settings import Settings
from ac_fake_workspace.testing import MakeClient


async def test_health_says_whether_the_corpus_loaded(
    make_client: MakeClient, tmp_path: Path
) -> None:
    loaded = await make_client().get("/health")
    assert loaded.json() == {"status": "ok", "service": "fake-workspace", "corpus_loaded": True}
    missing = await make_client(corpus_dir=tmp_path / "missing").get("/health")
    assert missing.status_code == 200
    assert missing.json() == {"status": "ok", "service": "fake-workspace", "corpus_loaded": False}


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
