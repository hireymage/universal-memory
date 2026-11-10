#!/bin/sh
# Loads the bearer token from a Docker secret file when MEMORY_API_TOKEN is not set,
# so the token never has to appear in `docker inspect` or compose environment.
set -eu
if [ -z "${MEMORY_API_TOKEN:-}" ] && [ -n "${MEMORY_API_TOKEN_FILE:-}" ]; then
  if [ ! -r "$MEMORY_API_TOKEN_FILE" ]; then
    echo "MEMORY_API_TOKEN_FILE=$MEMORY_API_TOKEN_FILE is not readable" >&2
    exit 1
  fi
  MEMORY_API_TOKEN="$(tr -d '\r\n' < "$MEMORY_API_TOKEN_FILE")"
  export MEMORY_API_TOKEN
fi
exec node /app/dist/cli.js --config "${MEMORY_CONFIG:-/config/config.yml}" "$@"
