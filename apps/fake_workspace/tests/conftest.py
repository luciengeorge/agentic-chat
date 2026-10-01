from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any, Literal

import httpx
import pytest

from ac_fake_workspace.app import create_app
from ac_fake_workspace.delivery import DeliveryPolicy
from ac_fake_workspace.settings import WorkspaceSettings
from ac_fake_workspace.testing import (
    Corpus,
    MakeClient,
    Receiver,
    build_corpus,
    serve_receiver,
)

FAST = DeliveryPolicy(
    max_attempts=3,
    base_delay_s=0.01,
    max_delay_s=0.02,
    timeout_s=2.0,
    retry_timeout_s=2.0,
    validation_timeout_s=0.5,
)


@pytest.fixture
def corpus(tmp_path: Path) -> Corpus:
    return build_corpus(tmp_path / "corpus")


@pytest.fixture
async def make_client(corpus: Corpus) -> AsyncIterator[MakeClient]:
    made: list[tuple[httpx.AsyncClient, Any]] = []

    def make(
        *,
        corpus_dir: Path | None = None,
        env: Literal["dev", "test", "prod"] = "dev",
        token: str | None = "dev-workspace-kestrel",
        policy: DeliveryPolicy | None = None,
    ) -> httpx.AsyncClient:
        settings = WorkspaceSettings(corpus_dir=corpus_dir or corpus.dir, env=env)
        app = create_app(settings, policy=policy or FAST)
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://fw", headers=headers
        )
        made.append((client, app))
        return client

    yield make
    for client, app in made:
        await client.aclose()
        await app.state.runtime.notifier.close()


@pytest.fixture
def client(make_client: MakeClient) -> httpx.AsyncClient:
    """Kestrel's connector."""
    return make_client()


@pytest.fixture
def receiver() -> Iterator[Receiver]:
    with serve_receiver() as rec:
        yield rec
