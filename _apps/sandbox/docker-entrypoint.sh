#!/bin/sh
set -e

# sshd backs the local-sync path: the laptop's Mutagen connects over SSH (through the sandbox's Cloudflare
# tunnel) and auto-injects its agent, which reads/writes /work. Key-only auth; the owner's public key is
# enrolled at runtime by the daemon's POST /system/authorized-key (authorized by the owner's Google token).

# The host key is the sandbox's SSH IDENTITY, so it must outlive the container. Every runner recreates this
# container — dev-sandbox.sh, rebuild.sh, update.sh and a provider update all `docker rm -f` + `docker run`,
# keeping only the named volumes — and the image used to carry a build-time `ssh-keygen -A`, so each rebuild
# shipped a NEW identity. The laptop pins the old one in its own known_hosts with `StrictHostKeyChecking
# accept-new`, which auto-accepts an unknown host but hard-refuses a CHANGED one, so sync died in the SSH
# handshake ("REMOTE HOST IDENTIFICATION HAS CHANGED", surfacing in `intentic-sync status` as the opaque "unable to
# read message length: unexpected EOF") and stayed dead until the entry was cleared by hand. Generating it once
# onto /history instead — the daemon's own volume, which already carries the ssh capability's keys (see
# capabilities/ssh-hosts.ts) and is outside the agent's /work mount — makes the identity stable across rebuilds.
# An explicit HostKey also narrows sshd to ed25519 (the baked `-A` made rsa/ecdsa too); every client that
# reaches this sandbox — OpenSSH and Mutagen's Go ssh — has supported it for a decade.
HISTORY_ROOT="${HISTORY_ROOT:-/history}"
host_key_dir="$HISTORY_ROOT/ssh-host-keys"
host_key="$host_key_dir/ssh_host_ed25519_key"
mkdir -p "$host_key_dir"
chmod 700 "$host_key_dir"
if [ ! -f "$host_key" ]; then
    ssh-keygen -q -t ed25519 -N "" -C intentic-sandbox -f "$host_key"
fi
printf 'HostKey %s\n' "$host_key" > /etc/ssh/sshd_config.d/intentic-hostkey.conf

# /run/sshd may be a fresh tmpfs at runtime, so (re)create it here rather than relying on the build layer.
mkdir -p /run/sshd
/usr/sbin/sshd

# The daemon is the main process — exec so it becomes PID 1 and owns SIGTERM/SIGINT graceful shutdown.
exec node /opt/sandbox/dist/main.js
