#!/bin/sh
set -e

# sshd backs the local-sync path: the laptop's Mutagen connects over SSH (through the sandbox's Cloudflare
# tunnel) and auto-injects its agent, which reads/writes /work. Key-only auth; the owner's public key is
# enrolled at runtime by the daemon's POST /system/authorized-key (authorized by the owner's Google token).
# /run/sshd may be a fresh tmpfs at runtime, so (re)create it here rather than relying on the build layer.
mkdir -p /run/sshd
/usr/sbin/sshd

# The daemon is the main process — exec so it becomes PID 1 and owns SIGTERM/SIGINT graceful shutdown.
exec node /opt/sandbox/dist/main.js
