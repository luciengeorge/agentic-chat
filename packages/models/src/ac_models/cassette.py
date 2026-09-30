"""VCR-style recordings of real API traffic, for reference evals and demos.

A cassette holds one test's HTTP exchanges in call order. Replay matches on
(test id, call index) and ignores the request body, so a prompt tweak doesn't
invalidate the recording. Streamed responses are stored as the raw SSE text.
"""

import json
import re
from pathlib import Path
from typing import Literal, TypedDict

import httpx2
from openai import AsyncOpenAI

from ac_models.openai_chat import OpenAIChatModel

type CassetteMode = Literal["replay", "record"]


class RecordedRequest(TypedDict):
    method: str
    path: str


class RecordedResponse(TypedDict):
    status: int
    content_type: str
    body: str


class Interaction(TypedDict):
    request: RecordedRequest
    response: RecordedResponse


class CassetteMissError(LookupError):
    pass


class Cassette:
    def __init__(self, directory: Path, test_id: str, mode: CassetteMode = "replay") -> None:
        self.test_id = test_id
        self.mode: CassetteMode = mode
        self.path = directory / f"{re.sub(r'[^A-Za-z0-9._-]+', '_', test_id)}.json"
        self.interactions: list[Interaction] = [] if mode == "record" else self._load()
        self._calls = 0

    def transport(
        self, inner: httpx2.AsyncBaseTransport | None = None
    ) -> httpx2.AsyncBaseTransport:
        if self.mode == "record":
            return _RecordingTransport(self, inner or httpx2.AsyncHTTPTransport())
        return _ReplayTransport(self)

    def next_index(self) -> int:
        index = self._calls
        self._calls += 1
        return index

    def append(self, interaction: Interaction) -> None:
        self.interactions.append(interaction)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps({"test_id": self.test_id, "interactions": self.interactions}, indent=2)
            + "\n",
            encoding="utf-8",
        )

    def _load(self) -> list[Interaction]:
        if not self.path.is_file():
            raise CassetteMissError(
                f"no cassette for {self.test_id} at {self.path}; run `ex record`"
            )
        data = json.loads(self.path.read_text(encoding="utf-8"))
        interactions: list[Interaction] = data["interactions"]
        return interactions


class _ReplayTransport(httpx2.AsyncBaseTransport):
    def __init__(self, cassette: Cassette) -> None:
        self._cassette = cassette

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        index = self._cassette.next_index()
        interactions = self._cassette.interactions
        if index >= len(interactions):
            raise CassetteMissError(
                f"{self._cassette.test_id} made call {index + 1} but the cassette holds "
                f"{len(interactions)}; run `ex record`"
            )
        recorded = interactions[index]
        if (recorded["request"]["method"], recorded["request"]["path"]) != (
            request.method,
            request.url.path,
        ):
            raise CassetteMissError(
                f"{self._cassette.test_id} call {index + 1} is "
                f"{request.method} {request.url.path}, "
                f"recorded {recorded['request']['method']} {recorded['request']['path']}; "
                "run `ex record`"
            )
        response = recorded["response"]
        return httpx2.Response(
            response["status"],
            headers={"content-type": response["content_type"]},
            content=response["body"].encode(),
            request=request,
        )


class _RecordingTransport(httpx2.AsyncBaseTransport):
    def __init__(self, cassette: Cassette, inner: httpx2.AsyncBaseTransport) -> None:
        self._cassette = cassette
        self._inner = inner

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        self._cassette.next_index()
        response = await self._inner.handle_async_request(request)
        try:
            body = await response.aread()
        finally:
            await response.aclose()
        content_type = response.headers.get("content-type", "application/json")
        self._cassette.append(
            {
                "request": {"method": request.method, "path": request.url.path},
                "response": {
                    "status": response.status_code,
                    "content_type": content_type,
                    "body": body.decode(),
                },
            }
        )
        return httpx2.Response(
            response.status_code,
            headers={"content-type": content_type},
            content=body,
            request=request,
        )

    async def aclose(self) -> None:
        await self._inner.aclose()


def cassette_chat_model(cassette: Cassette, *, api_key: str | None = None) -> OpenAIChatModel:
    """An OpenAI chat model whose HTTP traffic goes through the cassette.

    Replay needs no key. Recording needs a real one.
    """
    client = AsyncOpenAI(
        api_key=api_key or "cassette-replay",
        http_client=httpx2.AsyncClient(transport=cassette.transport()),
        max_retries=0,
    )
    return OpenAIChatModel(client)
