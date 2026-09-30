import pytest

from ac_workers.hello.greeting import format_greeting


@pytest.mark.parametrize("name", ["smoke", "Kestrel", "a b"])
def test_greets_by_name(name: str) -> None:
    assert format_greeting(name) == f"hello {name}"
