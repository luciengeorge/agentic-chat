import json

import httpx2
from openai import AsyncOpenAI

from ac_models import CHAT_MODEL, FakeChatModel, OpenAIChatModel


async def test_sends_model_and_explicit_reasoning_effort() -> None:
    reply = (await FakeChatModel(turns=["hi"]).respond("x", reasoning="low")).model_dump_json()
    sent: list[dict[str, object]] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        sent.append(json.loads(request.content))
        return httpx2.Response(200, headers={"content-type": "application/json"}, text=reply)

    client = AsyncOpenAI(
        api_key="test", http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    )
    response = await OpenAIChatModel(client).respond("hello", reasoning="low")
    assert response.output_text == "hi"
    assert sent == [{"model": CHAT_MODEL, "input": "hello", "reasoning": {"effort": "low"}}]
