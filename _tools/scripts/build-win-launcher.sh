#!/usr/bin/env bash
# Cross-compile the Windows launcher stub (_computers/win-launcher, Rust) — the ~200 KB GUI-subsystem program
# that starts a machine-side agent at logon without putting a console window on the desktop. Downloaded beside
# the agent it launches by computer.ps1 / sync.ps1, and named in the HKCU\…\Run value those agents register.
#
#   bash _tools/scripts/build-win-launcher.sh windows-x64
#
# Same cargo-xwin toolchain (MSVC) the desktop release and build-ic.sh already use, same explicit-target rule:
# the launcher ships for exactly the platforms the AGENTS ship for, because it is useless without one beside it.
#
# Artifacts land in _computers/win-launcher/dist-bin/ as intentic-launch-windows-<arch>.exe, from where
# publish-github.sh attaches them to the GitHub Release.
set -euo pipefail
. "$(dirname "$0")/repo-root.sh"
cd "$(repo_root)"

[ $# -ge 1 ] || { echo "usage: build-win-launcher.sh <target>... (windows-x64)" >&2; exit 2; }

MANIFEST="_computers/win-launcher/Cargo.toml"
OUT="_computers/win-launcher/dist-bin"
# CARGO_TARGET_DIR wins over the crate-local target/ wherever it is set (the release job points it at the
# shared /ci-cache store), so the copy below reads where cargo actually wrote — build-ic.sh's line, learned the
# same way.
TARGET_DIR="${CARGO_TARGET_DIR:-_computers/win-launcher/target}"
mkdir -p "$OUT"

command -v cargo >/dev/null 2>&1 || { echo "error: cargo (rustup) is required — https://rustup.rs" >&2; exit 1; }
if ! command -v cargo-xwin >/dev/null 2>&1; then
  echo "==> installing cargo-xwin"
  cargo install --locked cargo-xwin
fi

for target in "$@"; do
  case "$target" in
    windows-x64) triple="x86_64-pc-windows-msvc" name="intentic-launch-windows-amd64.exe" ;;
    windows-arm64) triple="aarch64-pc-windows-msvc" name="intentic-launch-windows-arm64.exe" ;;
    *) echo "error: unknown target '$target' — this crate is Windows-only by construction" >&2; exit 2 ;;
  esac
  rustup target add "$triple" >/dev/null
  echo "==> intentic-launch for $target ($triple)"
  # Dropped from the cache first, for the reason build-ic.sh spells out at length: cargo judges freshness by
  # mtime against a /ci-cache target dir several checkouts share, so a stale unit can be "Finished" without ever
  # being compiled — and this binary is one a user's PC downloads and runs at logon.
  cargo clean --manifest-path "$MANIFEST" --release --target "$triple" -p intentic-launch
  cargo xwin build --manifest-path "$MANIFEST" --release --target "$triple"
  src="$TARGET_DIR/${triple}/release/intentic-launch.exe"
  [ -f "$src" ] || { echo "error: no launcher binary at $src after building $target" >&2; exit 1; }
  cp "$src" "$OUT/$name"
  # …AND PROVE THE ONE PROPERTY THE WHOLE BINARY IS FOR, by asking the bytes rather than trusting the source.
  #
  # This program is useful only because its PE subsystem is WINDOWS (2) rather than CONSOLE (3): the loader
  # gives a console — and on Windows 11 a Terminal window — to every process of the second kind, which is the
  # bug it exists to remove. That property comes from one crate attribute, and it is invisible everywhere a
  # regression would be caught: an attribute deleted in a refactor, or silently ignored after a rustc change,
  # still builds, still installs, still starts the agent, and puts the window back on every user's desktop at
  # every boot with nothing failing anywhere. Two bytes of the header answer it for certain.
  node -e '
    const fs = require("fs");
    const image = fs.readFileSync(process.argv[1]);
    const header = image.readUInt32LE(0x3c);
    const subsystem = image.readUInt16LE(header + 24 + 68);
    if (subsystem !== 2) {
      console.error(`error: ${process.argv[1]} has PE subsystem ${subsystem}, not 2 (WINDOWS). A console-subsystem launcher maps a window at every logon, which is the whole thing it exists to prevent — check #![windows_subsystem = "windows"] in src/main.rs.`);
      process.exit(1);
    }
    console.log(`intentic-launch: PE subsystem verified (2 = WINDOWS, no console is ever allocated)`);
  ' "$OUT/$name"
  # SIGNED LIKE EVERYTHING ELSE A USER'S PC DOWNLOADS FROM US. This one carries an extra reason: a small
  # unsigned executable whose whole behaviour is "start a hidden process" is the exact shape heuristic AV
  # scoring is tuned against. No-op unless signing is configured.
  bash "$(dirname "$0")/sign-windows.sh" "$OUT/$name"
done

echo "==> launcher binaries in $OUT:"
ls -l "$OUT"
