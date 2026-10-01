# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/workers/Dockerfile --target prod .
ARG PACKAGE=ac-workers
ARG MODULE=ac_workers

FROM python:3.13.15-slim-trixie AS base
COPY --from=ghcr.io/astral-sh/uv:0.12.21 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --create-home app

FROM base AS deps
ARG PACKAGE
WORKDIR /repo
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-dev --no-install-workspace --package "$PACKAGE"

# Dev: Compose bind-mounts the repo over /repo. Workspace members are installed
# editable, so the venv imports the mounted source.
FROM deps AS dev
ARG PACKAGE
ARG MODULE
ENV UV_TOOL_BIN_DIR=/usr/local/bin \
    UV_TOOL_DIR=/opt/uv-tools \
    AC_PACKAGE=$PACKAGE \
    AC_MODULE=$MODULE
RUN --mount=type=cache,target=/root/.cache/uv uv tool install watchfiles==1.3.0
COPY . /repo
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --package "$PACKAGE" \
 && mkdir -p /home/app/.cache/uv \
 && chown -R app:app /opt/venv /home/app/.cache
USER app
CMD ["/repo/infra/python/dev-run.sh"]

FROM deps AS build
ARG PACKAGE
COPY . /repo
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable --package "$PACKAGE"

FROM python:3.13.15-slim-trixie AS prod
# Settings default to dev, which turns on dev-only surfaces such as fake-workspace's control API.
ENV AC_ENV=prod \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --no-create-home app
COPY --from=build /opt/venv /opt/venv
USER app
CMD ["python", "-m", "ac_workers"]
