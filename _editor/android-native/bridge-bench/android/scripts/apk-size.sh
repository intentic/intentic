#!/usr/bin/env bash
# What JNA adds to the release APK: builds it without JNA (-Pjna=false, only the jni mode) and with it, and prints the
# two sizes and every entry that differs. The APK left behind is the full one.
#
#   bash _editor/android-native/bridge-bench/android/scripts/apk-size.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APK="$HERE/../app/build/outputs/apk/release/app-release.apk"
OUT="$(mktemp -d)"

bash "$HERE/gradle.sh" --console=plain --quiet :app:assembleRelease -Pjna=false </dev/null >/dev/null
cp "$APK" "$OUT/without-jna.apk"
bash "$HERE/gradle.sh" --console=plain --quiet :app:assembleRelease </dev/null >/dev/null
cp "$APK" "$OUT/with-jna.apk"

# `unzip -lv` columns: length, method, stored size, ratio, date, time, CRC, name.
entries() { unzip -lv "$1" | awk 'NR > 3 && $8 != "" && $1 ~ /^[0-9]+$/ { print $8, $1, $3 }'; }
join -a1 -a2 -e0 -o 0,1.2,1.3,2.2,2.3 <(entries "$OUT/without-jna.apk" | sort) <(entries "$OUT/with-jna.apk" | sort) |
    awk '
        BEGIN { printf "%-36s %22s %22s\n", "entry (bytes: uncompressed / in the APK)", "without JNA", "with JNA" }
        $2 != $4 || $3 != $5 { printf "%-36s %10d / %9d %10d / %9d\n", $1, $2, $3, $4, $5 }'
printf '%-36s %22d %22d\n' "APK file" "$(stat -c %s "$OUT/without-jna.apk")" "$(stat -c %s "$OUT/with-jna.apk")"
rm -r "$OUT"
