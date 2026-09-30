# Pinned versions

Every image the stack runs, pinned. Checked against the registries on 2026-09-30. Bump them on purpose, one at a time.

| Image | Tag | Why / where from |
|---|---|---|
| Postgres (host, not Compose) | `postgresql@18` 18.6 + pgvector 0.8.6 | Homebrew on the host, reached from containers at `host.docker.internal:5432`. CI runs its own pgvector service |
| `valkey/valkey` | `9.1.2-alpine3.24` | Latest stable Valkey (9.2 is still an RC). Wire-compatible with Redis; the service is still called `redis` |
| `pgsty/minio` | `RELEASE.2026-08-04T00-00-00Z` | MinIO stopped publishing images (`minio/minio` is gone from Docker Hub and Quay). The Pigsty fork builds from upstream source and brings back the console on 9001 |
| `opensearchproject/opensearch` | `3.9.0` | Latest 3.x (Docker Hub). Security plugin off for dev |
| `temporalio/temporal` | `1.9.1` | The Temporal CLI image; `server start-dev` is Temporal's recommended dev server (SQLite, UI on 8233). `temporalio/auto-setup` is no longer updated |
| `quay.io/keycloak/keycloak` | `26.7.4` | Latest Keycloak (Quay; Keycloak doesn't publish to Docker Hub) |
| `envoyproxy/envoy` | `v1.39.1` | Latest Envoy release (Docker Hub) |
| `envoyproxy/ratelimit` | `63c7e9cc` | The project publishes only commit-SHA tags; this is master as of 2026-09-28. Distroless, so it has no healthcheck |
| `grafana/otel-lgtm` | `0.34.0` | Latest (Docker Hub). Grafana, Tempo, Loki, Prometheus and an OTel collector in one container |
| `python` | `3.13.15-slim-trixie` | Base for the app images; matches `.python-version` |
| `ghcr.io/astral-sh/uv` | `0.12.21` | Latest uv release; copied into the app images |
| `watchfiles` (PyPI) | `1.3.0` | Installed as a uv tool in the dev images to restart the apps on change |
