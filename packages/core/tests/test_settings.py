import pytest
from pydantic import ValidationError

from ac_core.settings import Settings


def settings() -> Settings:
    return Settings(_env_file=None)  # pyright: ignore[reportCallIssue]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("AC_ENV", "AC_MODEL_PROVIDER", "AC_DATABASE_URL", "OPENAI_API_KEY"):
        monkeypatch.delenv(name, raising=False)


def test_defaults_target_the_host() -> None:
    s = settings()
    assert s.env == "dev"
    assert s.database_url == "postgresql+psycopg://ac:ac@localhost:5432/ac"
    assert s.database_url_pooled == s.database_url
    assert s.temporal_address == "localhost:7233"
    assert s.model_provider == "fake"
    assert s.otel_exporter_otlp_endpoint == "http://localhost:4317"
    assert s.slot_root == "playground"
    assert s.active_step is None


def test_reads_prefixed_and_standard_env_vars(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AC_TEMPORAL_ADDRESS", "temporal:7233")
    monkeypatch.setenv("AC_MODEL_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://grafana:4317")
    s = settings()
    assert s.temporal_address == "temporal:7233"
    assert s.openai_api_key is not None
    assert s.openai_api_key.get_secret_value() == "sk-test"
    assert s.otel_exporter_otlp_endpoint == "http://grafana:4317"


def test_secrets_stay_out_of_repr(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    assert "sk-test" not in repr(settings())


def test_openai_provider_needs_a_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AC_MODEL_PROVIDER", "openai")
    with pytest.raises(ValidationError, match="OPENAI_API_KEY"):
        settings()


def test_rejects_unknown_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AC_ENV", "staging")
    with pytest.raises(ValidationError):
        settings()


def test_relay_partition_must_fit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AC_RELAY_PARTITION", "2")
    monkeypatch.setenv("AC_RELAY_PARTITIONS", "2")
    with pytest.raises(ValidationError, match="AC_RELAY_PARTITION"):
        settings()
