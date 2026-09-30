import json

import pytest
from openai.types.responses import (
    FunctionToolParam,
    ResponseFunctionToolCall,
    ResponseStreamEvent,
    ResponseTextDeltaEvent,
)

from ac_models import ChatModel, FakeChatModel, FakeChatModelExhaustedError, function_call

WEATHER_TOOL: FunctionToolParam = {
    "type": "function",
    "name": "get_weather",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
    "strict": True,
}


def test_satisfies_the_protocol() -> None:
    model: ChatModel = FakeChatModel(turns=[])
    assert model is not None


async def test_text_turn() -> None:
    model = FakeChatModel(turns=["hello there"])
    response = await model.respond("hi", reasoning="low")
    assert response.output_text == "hello there"
    assert response.status == "completed"


async def test_tool_call_turn_then_text() -> None:
    model = FakeChatModel(
        turns=[function_call("get_weather", {"city": "Paris"}, call_id="c1"), "sunny"]
    )
    first = await model.respond("weather?", reasoning="low", tools=[WEATHER_TOOL])
    [call] = first.output
    assert isinstance(call, ResponseFunctionToolCall)
    assert (call.name, json.loads(call.arguments), call.call_id) == (
        "get_weather",
        {"city": "Paris"},
        "c1",
    )
    second = await model.respond(
        [{"type": "function_call_output", "call_id": "c1", "output": "sunny"}], reasoning="low"
    )
    assert second.output_text == "sunny"


async def test_records_requests() -> None:
    model = FakeChatModel(turns=["a", "b"])
    await model.respond("one", reasoning="none", tools=[WEATHER_TOOL])
    async for _ in model.stream("two", reasoning="high"):
        pass
    assert [(r.input, r.reasoning, r.tools, r.stream) for r in model.requests] == [
        ("one", "none", [WEATHER_TOOL], False),
        ("two", "high", [], True),
    ]


async def test_running_out_of_turns_fails_loudly() -> None:
    model = FakeChatModel(turns=["only one"])
    await model.respond("1", reasoning="low")
    with pytest.raises(FakeChatModelExhaustedError, match="call 2"):
        await model.respond("2", reasoning="low")


async def collect(model: FakeChatModel) -> list[ResponseStreamEvent]:
    return [event async for event in model.stream("hi", reasoning="low")]


async def test_stream_text_matches_the_api_event_order() -> None:
    events = await collect(FakeChatModel(turns=["hello  streaming world "]))
    assert [e.type for e in events] == [
        "response.created",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.output_text.delta",
        "response.output_text.delta",
        "response.output_text.done",
        "response.content_part.done",
        "response.output_item.done",
        "response.completed",
    ]
    assert [e.sequence_number for e in events] == list(range(len(events)))
    deltas = "".join(e.delta for e in events if isinstance(e, ResponseTextDeltaEvent))
    assert deltas == "hello  streaming world "
    assert events[-1].type == "response.completed"
    assert events[-1].response.output_text == "hello  streaming world "


async def test_stream_tool_call() -> None:
    events = await collect(FakeChatModel(turns=[[function_call("f", {"x": 1}), "done"]]))
    types = [e.type for e in events]
    assert types[:5] == [
        "response.created",
        "response.output_item.added",
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
        "response.output_item.done",
    ]
    assert types[-1] == "response.completed"
