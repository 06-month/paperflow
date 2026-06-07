#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADDON_DIR="$ROOT_DIR/addon"
DIST_DIR="$ROOT_DIR/dist"
OUT="$DIST_DIR/paperflow.xpi"

mkdir -p "$DIST_DIR"
rm -f "$OUT"

cd "$ADDON_DIR"
# Exclude common OS/editor artifacts. XPI is a zip archive whose root must contain manifest.json.
zip -r "$OUT" . \
  -x '*.DS_Store' \
  -x '__MACOSX/*' \
  -x '*.log' \
  -x 'tmp/*' \
  -x '*.tmp' \
  -x '*.swp' \
  -x '*~'

echo "Built $OUT"
