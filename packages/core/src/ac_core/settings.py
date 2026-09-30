from functools import lru_cache
from typing import Literal, Self

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

LOCAL_DATABASE_URL = "postgresql+psycopg://ac:ac@localhost:5432/ac"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AC_", env_file=".env", extra="ignore")

    env: Literal["dev", "test", "prod"] = "dev"

    database_url: str = LOCAL_DATABASE_URL
    database_url_pooled: str = LOCAL_DATABASE_URL
    redis_url: str = "redis://localhost:6379/0"
    temporal_address: str = "localhost:7233"
    temporal_namespace: str = "default"
    opensearch_url: str = "http://localhost:9200"
    s3_endpoint: str = "http://localhost:9000"
    s3_access_key: str = "minioadmin"
    s3_secret_key: SecretStr = SecretStr("minioadmin")
    reranker_url: str = "http://localhost:8200"

    model_provider: Literal["fake", "cassette", "openai"] = "fake"
    cassette_mode: Literal["replay", "record"] = "replay"
    openai_api_key: SecretStr | None = Field(default=None, validation_alias="OPENAI_API_KEY")

    otel_exporter_otlp_endpoint: str = Field(
        default="http://localhost:4317", validation_alias="OTEL_EXPORTER_OTLP_ENDPOINT"
    )

    active_step: str | None = None
    slot_root: str = "playground"

    relay_partition: int = Field(default=0, ge=0)
    relay_partitions: int = Field(default=1, ge=1)

    @model_validator(mode="after")
    def _check(self) -> Self:
        if self.model_provider == "openai" and self.openai_api_key is None:
            raise ValueError("OPENAI_API_KEY is required when AC_MODEL_PROVIDER=openai")
        if self.relay_partition >= self.relay_partitions:
            raise ValueError("AC_RELAY_PARTITION must be less than AC_RELAY_PARTITIONS")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
