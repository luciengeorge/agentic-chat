from collections.abc import AsyncIterator, Sequence
from typing import Literal, Protocol

from openai.types.responses import Response, ResponseInputParam, ResponseStreamEvent, ToolParam

type ReasoningEffort = Literal["none", "low", "medium", "high", "xhigh", "max"]
type ChatInput = str | ResponseInputParam


class ChatModel(Protocol):
    """A Responses-API-shaped chat model. `reasoning` has no default on purpose."""

    async def respond(
        self,
        input: ChatInput,
        *,
        reasoning: ReasoningEffort,
        tools: Sequence[ToolParam] | None = None,
    ) -> Response: ...

    def stream(
        self,
        input: ChatInput,
        *,
        reasoning: ReasoningEffort,
        tools: Sequence[ToolParam] | None = None,
    ) -> AsyncIterator[ResponseStreamEvent]: ...


class EmbeddingModel(Protocol):
    async def embed(
        self, texts: list[str], *, dimensions: int | None = None
    ) -> list[list[float]]: ...


class Reranker(Protocol):
    async def rerank(self, query: str, docs: list[str], *, top_n: int) -> list[tuple[int, float]]:
        """(index into `docs`, score) pairs, best first."""
        ...
