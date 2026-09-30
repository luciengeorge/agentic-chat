#!/bin/sh
# Dev entrypoint for the Python app containers. Syncs the venv with the
# bind-mounted uv.lock, runs the optional one-off command given as arguments
# (the relay migrates the database this way), then runs `python -m $AC_MODULE`
# under watchfiles.
set -eu
cd /repo

uv sync --frozen --no-dev --package "$AC_PACKAGE"
[ "$#" -gt 0 ] && "$@"

app_dir="apps/${AC_MODULE#ac_}/src"
set -- packages "$app_dir"
[ -d playground ] && set -- "$@" playground

exec watchfiles --filter python "python -m $AC_MODULE" "$@"
