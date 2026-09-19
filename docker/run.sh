#!/bin/sh
# Runs the bunmsh VM image on the first free host port.
#
#   docker/run.sh [console|web] [extra docker run args...]
#
# `docker run -p 8080:8080` fails outright when something already holds 8080
# on the host, and Docker never picks another port for you. This walks 8080,
# 8081, 8082, ... until one is free, then publishes that port and tells the
# guest to listen on the same number, so the URL jsgotty prints is the URL
# that works from the host.
#
# Environment:
#   BUNMSH_PORT=8080      first port to try
#   BUNMSH_PORT_TRIES=10  how many consecutive ports to walk over
#   BUNMSH_IMAGE=bunmsh-vm  image to run
#   BUNMSH_DOCKER=docker  container CLI (podman works too)
#
# Everything the image itself understands (BUNMSH_MODE, BUNMSH_CREDENTIAL,
# BUNMSH_MEMORY, ...) is passed through from the environment as well.

set -eu

PORT=${BUNMSH_PORT:-8080}
TRIES=${BUNMSH_PORT_TRIES:-10}
IMAGE=${BUNMSH_IMAGE:-bunmsh-vm}
DOCKER=${BUNMSH_DOCKER:-docker}

case "${1:-}" in
  -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

# True when something is already listening on the port. Each probe is a
# best-effort check with a different tool; when none of them are installed the
# port is assumed free and Docker's own bind is left to be the judge.
port_taken() {
  port=$1
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    return 1
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1 && return 0
    return 1
  fi
  if command -v bash >/dev/null 2>&1; then
    bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" >/dev/null 2>&1 && return 0
    return 1
  fi
  return 1
}

chosen=
attempt=0
while [ "$attempt" -lt "$TRIES" ]; do
  candidate=$((PORT + attempt))
  attempt=$((attempt + 1))
  [ "$candidate" -gt 65535 ] && break
  if ! port_taken "$candidate"; then
    chosen=$candidate
    break
  fi
done

if [ -z "$chosen" ]; then
  echo "bunmsh-run: ports ${PORT}-$((PORT + TRIES - 1)) are all in use" >&2
  echo "bunmsh-run: set BUNMSH_PORT to start somewhere else, or BUNMSH_PORT_TRIES to widen the search" >&2
  exit 1
fi

[ "$chosen" = "$PORT" ] || echo "[bunmsh-run] port ${PORT} is in use; using ${chosen} instead"

# Forward the image's own settings when they are set here, so this wrapper is
# a drop-in for `docker run` rather than a narrower thing.
env_args=""
for name in BUNMSH_MODE BUNMSH_PID1 BUNMSH_SHELL BUNMSH_CREDENTIAL \
            BUNMSH_BUNINU_VERSION BUNMSH_MEMORY BUNMSH_CPUS BUNMSH_QEMU_EXTRA; do
  eval "value=\${$name:-}"
  [ -n "$value" ] && env_args="$env_args -e $name=$value"
done

# shellcheck disable=SC2086
exec "$DOCKER" run --rm -it \
  -p "${chosen}:${chosen}" \
  -e "BUNMSH_PORT=${chosen}" \
  $env_args \
  "$IMAGE" "$@"
