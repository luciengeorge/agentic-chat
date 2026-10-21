#!/usr/bin/env bash
# Runs inside the `airgap` Compose network (compose.yaml, profile airgap) and tries to leave it. Each line is one
# JSON result: what was tried, whether it got through, and how long it took to find out. `pnpm local:egress-check`
# reads them. Uses only what the paradedb image already has (bash, getent, timeout, pg_isready), so the check
# needs no image of its own.
set -u

now_ms() { echo $(($(date +%s%N) / 1000000)); }

emit() { printf '{"probe":"%s","target":"%s","reached":%s,"ms":%s,"detail":"%s"}\n' "$1" "$2" "$3" "$4" "$5"; }

dns() {
  local host=$1 start out code
  start=$(now_ms)
  out=$(timeout 10 getent hosts "$host" 2>&1)
  code=$?
  if [ "$code" = 0 ]; then
    emit dns "$host" true $(($(now_ms) - start)) "$(echo "$out" | head -1 | awk '{print $1}')"
  elif [ "$code" = 124 ]; then
    emit dns "$host" false $(($(now_ms) - start)) "timed out after 10 s"
  else
    emit dns "$host" false $(($(now_ms) - start)) "not resolved (getent exit $code)"
  fi
}

tcp() {
  local host=$1 port=$2 start err code
  start=$(now_ms)
  err=$(timeout 10 bash -c "exec 3<>/dev/tcp/$host/$port" 2>&1)
  code=$?
  if [ "$code" = 0 ]; then
    emit tcp "$host:$port" true $(($(now_ms) - start)) "connected"
  else
    err=$(echo "$err" | tail -1 | sed 's/.*: //; s/"//g')
    [ "$code" = 124 ] && err="timed out after 10 s"
    emit tcp "$host:$port" false $(($(now_ms) - start)) "$err"
  fi
}

dns api.openai.com
dns api.cohere.com
dns huggingface.co
tcp api.openai.com 443
tcp api.cohere.com 443
# An address needs no DNS: this is the route itself.
tcp 1.1.1.1 443
tcp 8.8.8.8 53
# The host machine, where LM Studio listens: off the network too.
tcp host.docker.internal 1234
tcp airgap-db 5432

start=$(now_ms)
if pg_isready -q -h airgap-db -U ac -d ac -t 5; then
  emit postgres airgap-db:5432 true $(($(now_ms) - start)) "accepting connections"
else
  emit postgres airgap-db:5432 false $(($(now_ms) - start)) "not ready"
fi
