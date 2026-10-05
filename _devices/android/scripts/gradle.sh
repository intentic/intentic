#!/usr/bin/env bash
# Runs the pinned Gradle for this project, downloading it once into a cache and checking its digest first.
#
#   bash _devices/android/scripts/gradle.sh :app:testDirectDebugUnitTest :app:assembleDirectDebug
#
# There is no Gradle wrapper in the repository: its jar is a binary nobody reviews. The version and digest below are
# the wrapper's whole job, written where a diff shows them. Change both together, from
# https://services.gradle.org/distributions/gradle-<version>-bin.zip.sha256.
set -euo pipefail

VERSION="9.6.0"
SHA256="bbaeb2fef8710818cf0e261201dab964c572f92b942812df0c3620d62a529a01"

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${GRADLE_DIST_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/intentic-gradle}"
HOME_DIR="$CACHE/gradle-$VERSION"

if [ ! -x "$HOME_DIR/bin/gradle" ]; then
    mkdir -p "$CACHE"
    zip="$CACHE/gradle-$VERSION-bin.zip"
    curl --fail --location --silent --show-error --retry 3 --output "$zip.part" "https://services.gradle.org/distributions/gradle-$VERSION-bin.zip"
    echo "$SHA256  $zip.part" | sha256sum --check --quiet
    mv "$zip.part" "$zip"
    unzip -q -o "$zip" -d "$CACHE"
fi

exec "$HOME_DIR/bin/gradle" --project-dir "$PROJECT" "$@"
