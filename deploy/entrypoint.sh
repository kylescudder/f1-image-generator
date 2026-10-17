#!/bin/sh
set -eu
mkdir -p "${DATA_DIR:-/app/data}/fonts"
for face in wide bold; do
  if [ ! -f "${DATA_DIR:-/app/data}/fonts/$face.woff2" ]; then
    cp "/app/runtime-fonts/$face.woff2" "${DATA_DIR:-/app/data}/fonts/$face.woff2"
  fi
done
exec node --import tsx /app/server/index.ts
