from collections.abc import AsyncIterator, Sequence

from openai import AsyncOpenAI, Omit, omit
from openai.types.responses import Response, ResponseStreamEvent, ToolParam

from ac_models.config import CHAT_MODEL
from ac_models.protocols import ChatInput, ReasoningEffort


class OpenAIChatModel:
    def __init__(self, client: AsyncOpenAI, model: str = CHAT_MODEL) -> None:
        self._client = client
        self.model = model

    async def respond(
        self,
        input: ChatInput,
        *,
        reasoning: ReasoningEffort,
        tools: Sequence[ToolParam] | None = None,
    ) -> Response:
        return await self._client.responses.create(
            model=self.model,
            input=input,
            reasoning={"effort": reasoning},
            tools=_tools(tools),
        )

    async def stream(
        self,
        input: ChatInput,
        *,
        reasoning: ReasoningEffort,
        tools: Sequence[ToolParam] | None = None,
    ) -> AsyncIterator[ResponseStreamEvent]:
        events = await self._client.responses.create(
            model=self.model,
            input=input,
            reasoning={"effort": reasoning},
            tools=_tools(tools),
            stream=True,
        )
        async with events:
            async for event in events:
                yield event


def _tools(tools: Sequence[ToolParam] | None) -> list[ToolParam] | Omit:
    return list(tools) if tools else omit
