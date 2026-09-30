import asyncio
import threading
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI

from ac_reranker.app import create_app
from ac_reranker.scorer import Scorer


class KeywordScorer:
    """Scores by how many query words each text contains."""

    def score(self, query: str, texts: list[str], *, raw: bool) -> list[float]:
        words = query.lower().split()
        counts = [float(sum(w in t.lower() for w in words)) for t in texts]
        return counts if raw else [c / len(words) for c in counts]


@asynccontextmanager
async def serve(load: Callable[[], Scorer]) -> AsyncGenerator[httpx.AsyncClient]:
    app: FastAPI = create_app(load)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://rr") as client,
    ):
        yield client


async def wait_ready(client: httpx.AsyncClient) -> None:
    async with asyncio.timeout(5):
        while (await client.get("/health")).status_code != 200:  # noqa: ASYNC110
            await asyncio.sleep(0.01)


async def test_health_reports_loading_until_the_model_is_ready() -> None:
    release = threading.Event()

    def load() -> Scorer:
        release.wait(5)
        return KeywordScorer()

    async with serve(load) as client:
        loading = await client.get("/health")
        assert (loading.status_code, loading.json()["status"]) == (503, "loading")
        busy = await client.post("/rerank", json={"query": "q", "texts": ["t"]})
        assert busy.status_code == 503
        release.set()
        await wait_ready(client)
        assert (await client.get("/health")).json() == {"status": "ok", "service": "reranker"}


async def test_rerank_uses_the_tei_schema_best_first() -> None:
    async with serve(KeywordScorer) as client:
        await wait_ready(client)
        response = await client.post(
            "/rerank",
            json={
                "query": "expense policy",
                "texts": ["lunch menu", "expense policy 2026", "travel expense"],
            },
        )
    assert response.json() == [
        {"index": 1, "score": 1.0, "text": None},
        {"index": 2, "score": 0.5, "text": None},
        {"index": 0, "score": 0.0, "text": None},
    ]


async def test_rerank_raw_scores_and_return_text() -> None:
    async with serve(KeywordScorer) as client:
        await wait_ready(client)
        response = await client.post(
            "/rerank",
            json={
                "query": "a b",
                "texts": ["a", "a b"],
                "raw_scores": True,
                "return_text": True,
            },
        )
    assert response.json() == [
        {"index": 1, "score": 2.0, "text": "a b"},
        {"index": 0, "score": 1.0, "text": "a"},
    ]


async def test_empty_batch_is_400() -> None:
    async with serve(KeywordScorer) as client:
        await wait_ready(client)
        response = await client.post("/rerank", json={"query": "q", "texts": []})
    assert response.status_code == 400
    assert response.json() == {"error": "Batch is empty", "error_type": "empty"}
