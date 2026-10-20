#!/bin/sh
set -eu
mkdir -p "${DATA_DIR:-/app/data}/fonts"
for face in wide bold; do
  if [ ! -f "${DATA_DIR:-/app/data}/fonts/$face.woff2" ]; then
    cp "/app/runtime-fonts/$face.woff2" "${DATA_DIR:-/app/data}/fonts/$face.woff2"
  fi
done
# The host migrates with a separate owner credential; local Compose has one role and migrates here.
if [ "${PADDOCK_MIGRATE:-}" = "1" ]; then
  bun /app/server/migrate.ts
fi
exec bun /app/server/production.ts
