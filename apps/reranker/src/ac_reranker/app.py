"""TEI's `/rerank` schema over a local sentence-transformers cross-encoder.

TEI has no Apple-silicon image, so this stands in for it locally. Same request
and response shapes, so callers can't tell the difference.
"""

import asyncio
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager
from typing import Literal

import structlog
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ac_core.health import health_router
from ac_core.tracing import FASTAPI_TELEMETRY
from ac_reranker.scorer import Scorer

SERVICE = "reranker"

log = structlog.get_logger(__name__)


class RerankRequest(BaseModel):
    query: str
    texts: list[str]
    raw_scores: bool = False
    return_text: bool = False
    # Accepted for compatibility. The cross-encoder always truncates to its max length,
    # on the right.
    truncate: bool | None = False
    truncation_direction: Literal["Left", "Right"] = "Right"


class Rank(BaseModel):
    index: int
    score: float
    text: str | None = None


class ErrorResponse(BaseModel):
    error: str
    error_type: str


def create_app(load_scorer: Callable[[], Scorer]) -> FastAPI:
    """The model loads in a thread after startup. `/health` answers "loading" until it's ready."""
    scorer: Scorer | None = None

    async def load() -> None:
        nonlocal scorer
        scorer = await asyncio.to_thread(load_scorer)
        log.info("reranker.loaded")

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncGenerator[None]:
        task = asyncio.create_task(load())
        yield
        task.cancel()

    app = FastAPI(title="reranker", lifespan=lifespan, telemetry=FASTAPI_TELEMETRY)
    app.include_router(health_router(SERVICE, ready=lambda: scorer is not None))

    @app.post(
        "/rerank",
        response_model=list[Rank],
        responses={400: {"model": ErrorResponse}, 503: {"model": ErrorResponse}},
    )
    async def rerank(request: RerankRequest) -> list[Rank] | JSONResponse:  # pyright: ignore[reportUnusedFunction]
        if scorer is None:
            return _error(503, "Model is loading", "unhealthy")
        if not request.texts:
            return _error(400, "Batch is empty", "empty")
        scores = await asyncio.to_thread(
            scorer.score, request.query, request.texts, raw=request.raw_scores
        )
        ranks = [
            Rank(index=i, score=s, text=request.texts[i] if request.return_text else None)
            for i, s in enumerate(scores)
        ]
        return sorted(ranks, key=lambda r: r.score, reverse=True)

    return app


def _error(status: int, error: str, error_type: str) -> JSONResponse:
    return JSONResponse(
        ErrorResponse(error=error, error_type=error_type).model_dump(), status_code=status
    )
