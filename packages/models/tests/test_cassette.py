import json
from pathlib import Path

import httpx2
import pytest
from openai import AsyncOpenAI
from openai.types.responses import ResponseStreamEvent

from ac_models import (
    Cassette,
    CassetteMissError,
    FakeChatModel,
    OpenAIChatModel,
    cassette_chat_model,
)

TEST_ID = "exercises/01.x/test_chat.py::test_streams[a]"


async def sse_body(text: str) -> str:
    events = [e async for e in FakeChatModel(turns=[text]).stream("x", reasoning="low")]
    return "".join(f"event: {e.type}\ndata: {e.model_dump_json()}\n\n" for e in events)


async def record(tmp_path: Path, texts: list[str]) -> Cassette:
    bodies = [await sse_body(t) for t in texts]

    def upstream(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200, headers={"content-type": "text/event-stream"}, text=bodies.pop(0)
        )

    cassette = Cassette(tmp_path, TEST_ID, mode="record")
    client = AsyncOpenAI(
        api_key="sk-real",
        http_client=httpx2.AsyncClient(
            transport=cassette.transport(httpx2.MockTransport(upstream))
        ),
    )
    model = OpenAIChatModel(client)
    for _ in texts:
        async for _event in model.stream("recorded prompt", reasoning="low"):
            pass
    return cassette


def text_of(events: list[ResponseStreamEvent]) -> str:
    assert events[-1].type == "response.completed"
    return events[-1].response.output_text


async def test_record_then_replay_by_call_index(tmp_path: Path) -> None:
    await record(tmp_path, ["first", "second"])
    model = cassette_chat_model(Cassette(tmp_path, TEST_ID))
    first = [e async for e in model.stream("a different prompt", reasoning="high")]
    second = [e async for e in model.stream("the body is ignored", reasoning="none")]
    assert text_of(first) == "first"
    assert text_of(second) == "second"


async def test_stores_raw_sse_and_no_credentials(tmp_path: Path) -> None:
    cassette = await record(tmp_path, ["hi"])
    raw = cassette.path.read_text()
    assert "sk-real" not in raw
    [interaction] = json.loads(raw)["interactions"]
    assert interaction["request"] == {"method": "POST", "path": "/v1/responses"}
    assert interaction["response"]["content_type"] == "text/event-stream"
    assert interaction["response"]["body"].startswith("event: response.created\ndata: {")


async def test_extra_call_is_a_miss(tmp_path: Path) -> None:
    await record(tmp_path, ["only"])
    model = cassette_chat_model(Cassette(tmp_path, TEST_ID))
    assert text_of([e async for e in model.stream("x", reasoning="low")]) == "only"
    with pytest.raises(CassetteMissError, match="call 2"):
        await model.respond("x", reasoning="low")


def test_missing_cassette(tmp_path: Path) -> None:
    with pytest.raises(CassetteMissError, match="ex record"):
        Cassette(tmp_path, "nope")
