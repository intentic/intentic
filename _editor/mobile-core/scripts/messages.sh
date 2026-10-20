#!/usr/bin/env bash
# Writes the app's types for the bridge's messages from src/bridge/messages.rs, or with --check fails when the
# committed ones differ from what the Rust says. Needs typeshare-cli 1.13 (`cargo install typeshare-cli --locked`).
#
#   bash _editor/mobile-core/scripts/messages.sh [--check]
set -euo pipefail

CORE="$(cd "$(dirname "$0")/.." && pwd)"
KOTLIN="$CORE/../android-app/app/src/main/kotlin/dev/intentic/app/core/Messages.kt"

if [ "${1:-}" = "--check" ]; then
    written="$(mktemp -d)/Messages.kt"
    RUST_LOG=error typeshare "$CORE/src/bridge" --lang=kotlin --config-file="$CORE/typeshare.toml" --output-file="$written" >/dev/null
    diff -u "$KOTLIN" "$written" || { echo "Messages.kt is stale: run $0" >&2; exit 1; }
else
    mkdir -p "$(dirname "$KOTLIN")"
    RUST_LOG=error typeshare "$CORE/src/bridge" --lang=kotlin --config-file="$CORE/typeshare.toml" --output-file="$KOTLIN" >/dev/null
fi
