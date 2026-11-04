#!/usr/bin/env bash
# One-time setup: Python venv for the generator plus a pinned Apache Ossie checkout
# (the official validator and JSON Schema are not part of the pip package).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OSSIE_COMMIT=01a5488
OSSIE_DIR="${WAREHOUSE_DIR:-/var/lib/lucero}/semantic/ossie-src"

if [ ! -d "$OSSIE_DIR/.git" ]; then
  git clone --quiet https://github.com/apache/ossie.git "$OSSIE_DIR"
fi
git -C "$OSSIE_DIR" fetch --quiet origin
git -C "$OSSIE_DIR" checkout --quiet "$OSSIE_COMMIT"

python3 -m venv "$HERE/.venv"
"$HERE/.venv/bin/pip" install --quiet --upgrade pip
"$HERE/.venv/bin/pip" install --quiet -r "$HERE/requirements.txt"
echo "semantic: ossie $(git -C "$OSSIE_DIR" rev-parse --short HEAD), venv ready"
