"""Cassette fixtures, loaded into every pytest run through the `pytest11` entry point.

Cassettes live in a `cassettes/` directory next to the test file. `AC_CASSETTE_MODE=record`
(what `ex record` sets) re-records them against the real API; the default replays.
"""

from pathlib import Path
from typing import cast

import pytest

from ac_core.settings import Settings
from ac_models.cassette import Cassette, cassette_chat_model
from ac_models.openai_chat import OpenAIChatModel


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers", "cassette: replays recorded API traffic; `ex record` refreshes it"
    )


@pytest.fixture
def cassette(request: pytest.FixtureRequest) -> Cassette:
    # Keyed relative to the test file, so the id doesn't change with pytest's rootdir.
    path = Path(request.path)
    node = cast(pytest.Item, request.node)  # pyright: ignore[reportUnknownMemberType]
    test_id = f"{path.name}::{node.nodeid.split('::', 1)[1]}"
    return Cassette(path.parent / "cassettes", test_id, mode=Settings().cassette_mode)


@pytest.fixture
def cassette_model(cassette: Cassette) -> OpenAIChatModel:
    if cassette.mode == "replay":
        return cassette_chat_model(cassette)
    key = Settings().openai_api_key
    if key is None:
        raise pytest.UsageError("AC_CASSETTE_MODE=record needs OPENAI_API_KEY")
    return cassette_chat_model(cassette, api_key=key.get_secret_value())
