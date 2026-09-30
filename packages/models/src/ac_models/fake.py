import json
import re
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass

from openai.types.responses import (
    Response,
    ResponseCompletedEvent,
    ResponseContentPartAddedEvent,
    ResponseContentPartDoneEvent,
    ResponseCreatedEvent,
    ResponseFunctionCallArgumentsDeltaEvent,
    ResponseFunctionCallArgumentsDoneEvent,
    ResponseFunctionToolCall,
    ResponseOutputItem,
    ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent,
    ResponseOutputMessage,
    ResponseOutputText,
    ResponseStreamEvent,
    ResponseTextDeltaEvent,
    ResponseTextDoneEvent,
    ToolParam,
)

from ac_models.protocols import ChatInput, ReasoningEffort

type Turn = str | ResponseFunctionToolCall | Sequence[str | ResponseFunctionToolCall]
"""One scripted model reply: text, a tool call, or several output items in order."""


@dataclass(frozen=True)
class ChatRequest:
    input: ChatInput
    reasoning: ReasoningEffort
    tools: list[ToolParam]
    stream: bool


class FakeChatModelExhaustedError(AssertionError):
    pass


def function_call(
    name: str, arguments: Mapping[str, object], *, call_id: str | None = None
) -> ResponseFunctionToolCall:
    return ResponseFunctionToolCall(
        type="function_call",
        name=name,
        arguments=json.dumps(arguments),
        call_id=call_id or f"call_{name}",
        status="completed",
    )


class FakeChatModel:
    """Replies with scripted turns in order and records every request it receives."""

    model = "fake"

    def __init__(self, turns: Sequence[Turn]) -> None:
        self._turns = list(turns)
        self.requests: list[ChatRequest] = []

    async def respond(
        self,
        input: ChatInput,
        *,
        reasoning: ReasoningEffort,
        tools: Sequence[ToolParam] | None = None,
    ) -> Response:
        return self._next(ChatRequest(input, reasoning, list(tools or []), stream=False))

    async def stream(
        self,
        input: ChatInput,
        *,
        reasoning: ReasoningEffort,
        tools: Sequence[ToolParam] | None = None,
    ) -> AsyncIterator[ResponseStreamEvent]:
        response = self._next(ChatRequest(input, reasoning, list(tools or []), stream=True))
        for event in _events(response):
            yield event

    def _next(self, request: ChatRequest) -> Response:
        index = len(self.requests)
        self.requests.append(request)
        if index >= len(self._turns):
            raise FakeChatModelExhaustedError(
                f"FakeChatModel got call {index + 1} but only {len(self._turns)} turns are scripted"
            )
        turn = self._turns[index]
        parts: Sequence[str | ResponseFunctionToolCall] = (
            [turn] if isinstance(turn, str | ResponseFunctionToolCall) else turn
        )
        output = [_item(part, f"{index}_{i}") for i, part in enumerate(parts)]
        return _response(f"resp_fake_{index}", output, status="completed")


def _item(part: str | ResponseFunctionToolCall, suffix: str) -> ResponseOutputItem:
    if isinstance(part, str):
        return ResponseOutputMessage(
            type="message",
            id=f"msg_fake_{suffix}",
            role="assistant",
            status="completed",
            content=[ResponseOutputText(type="output_text", text=part, annotations=[])],
        )
    return part.model_copy(update={"id": part.id or f"fc_fake_{suffix}"})


def _response(id: str, output: list[ResponseOutputItem], *, status: str) -> Response:
    return Response.model_validate(
        {
            "id": id,
            "object": "response",
            "created_at": 0,
            "model": FakeChatModel.model,
            "status": status,
            "output": [item.model_dump() for item in output],
            "parallel_tool_calls": True,
            "tool_choice": "auto",
            "tools": [],
        }
    )


def _events(response: Response) -> list[ResponseStreamEvent]:
    """The same event sequence the Responses API streams, minus logprobs and reasoning."""
    events: list[ResponseStreamEvent] = [
        ResponseCreatedEvent(
            type="response.created",
            sequence_number=0,
            response=_response(response.id, [], status="in_progress"),
        )
    ]

    def seq() -> int:
        return len(events)

    for index, item in enumerate(response.output):
        if isinstance(item, ResponseOutputMessage):
            events.append(
                ResponseOutputItemAddedEvent(
                    type="response.output_item.added",
                    sequence_number=seq(),
                    output_index=index,
                    item=item.model_copy(update={"status": "in_progress", "content": []}),
                )
            )
            for content_index, part in enumerate(item.content):
                if not isinstance(part, ResponseOutputText):
                    continue
                events.append(
                    ResponseContentPartAddedEvent(
                        type="response.content_part.added",
                        sequence_number=seq(),
                        item_id=item.id,
                        output_index=index,
                        content_index=content_index,
                        part=part.model_copy(update={"text": ""}),
                    )
                )
                for delta in _chunks(part.text):
                    events.append(
                        ResponseTextDeltaEvent(
                            type="response.output_text.delta",
                            sequence_number=seq(),
                            item_id=item.id,
                            output_index=index,
                            content_index=content_index,
                            delta=delta,
                            logprobs=[],
                        )
                    )
                events.append(
                    ResponseTextDoneEvent(
                        type="response.output_text.done",
                        sequence_number=seq(),
                        item_id=item.id,
                        output_index=index,
                        content_index=content_index,
                        text=part.text,
                        logprobs=[],
                    )
                )
                events.append(
                    ResponseContentPartDoneEvent(
                        type="response.content_part.done",
                        sequence_number=seq(),
                        item_id=item.id,
                        output_index=index,
                        content_index=content_index,
                        part=part,
                    )
                )
        elif isinstance(item, ResponseFunctionToolCall):
            item_id = item.id or ""
            events.append(
                ResponseOutputItemAddedEvent(
                    type="response.output_item.added",
                    sequence_number=seq(),
                    output_index=index,
                    item=item.model_copy(update={"status": "in_progress", "arguments": ""}),
                )
            )
            events.append(
                ResponseFunctionCallArgumentsDeltaEvent(
                    type="response.function_call_arguments.delta",
                    sequence_number=seq(),
                    item_id=item_id,
                    output_index=index,
                    delta=item.arguments,
                )
            )
            events.append(
                ResponseFunctionCallArgumentsDoneEvent(
                    type="response.function_call_arguments.done",
                    sequence_number=seq(),
                    item_id=item_id,
                    output_index=index,
                    arguments=item.arguments,
                )
            )
        events.append(
            ResponseOutputItemDoneEvent(
                type="response.output_item.done",
                sequence_number=seq(),
                output_index=index,
                item=item,
            )
        )
    events.append(
        ResponseCompletedEvent(type="response.completed", sequence_number=seq(), response=response)
    )
    return events


def _chunks(text: str) -> list[str]:
    """Word-sized deltas, spaces kept, so joining them gives back the text."""
    return re.findall(r"\s*\S+\s*|\s+", text)
