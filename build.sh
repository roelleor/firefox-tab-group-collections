#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$ROOT_DIR/dist"
PACKAGE_NAME="tab-group-collections.zip"

mkdir -p "$DIST_DIR"
rm -f "$DIST_DIR/$PACKAGE_NAME"

cd "$ROOT_DIR"

zip -r -FS "$DIST_DIR/$PACKAGE_NAME" \
  manifest.json \
  background.js \
  sidebar.html \
  sidebar.css \
  sidebar.js \
  popup.html \
  popup.css \
  popup.js \
  icons \
  -x '*.DS_Store' \
  -x '__MACOSX/*' \
  -x '*/._*'

echo "Created $DIST_DIR/$PACKAGE_NAME"
