import json

import pytest

from ac_models import FakeChatModel

TEST = """
import pytest

@pytest.mark.cassette
async def test_chat(cassette_model):
    response = await cassette_model.respond("anything", reasoning="low")
    assert response.output_text == "recorded"
"""


async def recorded_body() -> str:
    response = await FakeChatModel(turns=["recorded"]).respond("x", reasoning="low")
    return response.model_dump_json()


async def test_cassette_model_replays_from_cassettes_dir(
    pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AC_CASSETTE_MODE", raising=False)
    pytester.makepyfile(test_chat=TEST)
    cassettes = pytester.mkdir("cassettes")
    interaction = {
        "request": {"method": "POST", "path": "/v1/responses"},
        "response": {
            "status": 200,
            "content_type": "application/json",
            "body": await recorded_body(),
        },
    }
    (cassettes / "test_chat.py_test_chat.json").write_text(
        json.dumps({"test_id": "test_chat.py::test_chat", "interactions": [interaction]})
    )
    result = pytester.runpytest_subprocess(
        "-m", "cassette", "-p", "no:cacheprovider", "-o", "asyncio_mode=auto"
    )
    result.assert_outcomes(passed=1)


def test_missing_cassette_errors_with_a_hint(
    pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("AC_CASSETTE_MODE", raising=False)
    pytester.makepyfile(test_chat=TEST)
    result = pytester.runpytest_subprocess("-p", "no:cacheprovider")
    result.assert_outcomes(errors=1)
    result.stdout.fnmatch_lines(["*CassetteMissError*ex record*"])
