from collections.abc import Iterator

import pytest

from ac_core.settings import Settings
from ac_db.testing import postgres_reachable, temporary_database


@pytest.fixture(scope="session")
def database_url() -> Iterator[str]:
    url = Settings().database_url
    if not postgres_reachable(url):
        pytest.skip(f"Postgres not reachable at {url}")
    with temporary_database(url) as test_url:
        yield test_url
