#!/usr/bin/env bash
# Build intentic-engine-<version>-x86_64.tar.gz — a WSL-importable rootfs with Alpine + static dockerd.
# CI runs this on Linux; developers can run it locally to refresh the tarball and checksum.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PINS="$ROOT/pins.toml"
OUT_DIR="${1:-$(cd "$ROOT/.." && pwd)/dist-bin}"

read_pin() {
  local key="$1"
  sed -n "s/^${key} = \"\(.*\)\"/\1/p" "$PINS" | head -1
}

ENGINE_VERSION="$(read_pin engine_version)"
ALPINE_URL="$(read_pin alpine_url)"
ALPINE_SHA="$(read_pin alpine_sha256)"
DOCKER_URL="$(read_pin docker_tgz_url)"
DOCKER_SHA="$(read_pin docker_tgz_sha256)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

verify() {
  local path="$1" want="$2"
  got="$(sha256_file "$path")"
  if [ "$got" != "$want" ]; then
    echo "sha256 mismatch for $path: got $got want $want" >&2
    exit 1
  fi
}

fetch_url() {
  local url="$1" dest="$2" sha="$3"
  if [ ! -f "$dest" ]; then
    curl -fsSL -o "$dest" "$url"
  fi
  verify "$dest" "$sha"
}

mkdir -p "$WORK/rootfs"
fetch_url "$ALPINE_URL" "$WORK/alpine.tar.gz" "$ALPINE_SHA"
tar -xzf "$WORK/alpine.tar.gz" -C "$WORK/rootfs"

fetch_url "$DOCKER_URL" "$WORK/docker.tgz" "$DOCKER_SHA"
mkdir -p "$WORK/rootfs/usr/local/bin"
tar -xzf "$WORK/docker.tgz" -C "$WORK"
for bin in dockerd containerd containerd-shim-runc-v2 runc docker-init docker-proxy; do
  install -m 755 "$WORK/docker/$bin" "$WORK/rootfs/usr/local/bin/$bin"
done

mkdir -p "$WORK/rootfs/usr/local/bin" "$WORK/rootfs/etc" "$WORK/rootfs/etc/intentic-engine/tls"
install -m 755 "$ROOT/rootfs/intentic-engine" "$WORK/rootfs/usr/local/bin/intentic-engine"
install -m 644 "$ROOT/rootfs/wsl.conf" "$WORK/rootfs/etc/wsl.conf"

# dockerd bridge NAT needs iptables; TLS at install needs openssl; HTTPS pulls need ca-certificates.
cp /etc/resolv.conf "$WORK/rootfs/etc/resolv.conf"
run_chroot() {
  if chroot "$WORK/rootfs" "$@"; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo chroot "$WORK/rootfs" "$@"
  else
    echo "error: chroot into rootfs failed and sudo is not available" >&2
    return 1
  fi
}
# passt (pasta) and socat give dockerd a network namespace of its own: the way out, and the loopback forwards in
# (rootfs/intentic-engine). A distro imported from 1.0.0 fetches them on its first start of a newer keeper.
run_chroot /sbin/apk add --no-cache iptables ip6tables openssl ca-certificates passt socat
rm -f "$WORK/rootfs/etc/resolv.conf"

NAME="intentic-engine-${ENGINE_VERSION}-x86_64.tar.gz"
mkdir -p "$OUT_DIR"
tar -C "$WORK/rootfs" -czf "$OUT_DIR/$NAME" .
sha256sum "$OUT_DIR/$NAME" | awk '{print $1}' >"$OUT_DIR/$NAME.sha256"
echo "built $OUT_DIR/$NAME ($(du -h "$OUT_DIR/$NAME" | awk '{print $1}'))"
