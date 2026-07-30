#!/bin/sh
set -e

# sshd backs the local-sync path: the laptop's Mutagen connects over SSH (through the sandbox's Cloudflare
# tunnel) and auto-injects its agent, which reads/writes /work. Key-only auth; the owner's public key is
# enrolled at runtime by the daemon's POST /system/authorized-key (authorized by the owner's Google token).

# The host key is the sandbox's SSH IDENTITY, so it must outlive the container. Every runner recreates this
# container — recreate.sh (any mode) and a provider update all `docker rm -f` + `docker run`,
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

# DNS THAT CANNOT FREEZE THE DAEMON.
#
# Measured in this sandbox: reverse-resolving the Docker gateway (the address EVERY browser and host connection
# arrives from) takes 8.004s and ends in NXDOMAIN. Docker's embedded resolver has no PTR record for it, forwards
# to the host, is answered by nobody, and glibc pays its full ladder — two attempts at the 4s per-query timeout.
# One lookup per peer, done in sequence, and the daemon's event loop is dead for the whole run: 6 peers froze it
# for 48s, 16 for 128s. No heartbeat goes out, so the browser's 10s liveness watchdog declares the sandbox gone
# and the UI locks up — the outage users actually report. Container IPs on the same network resolve instantly
# (the embedded server knows them); it is only the gateway that costs 8s.
#
# Two independent guards, because either alone leaves a hole:
#  - names for the local subnet's ends in /etc/hosts. nsswitch is `files dns`, and glibc's files backend answers
#    REVERSE lookups too, so the gateway's PTR never reaches the resolver at all. 8.004s -> 0.001s, measured.
#  - a bounded resolver ladder, which caps every OTHER unresolvable name (a telemetry host, a typo'd remote) at
#    ~2s instead of 8s. Docker leaves an edited resolv.conf alone, but only for the life of the container.
#
# Both files are runtime bind mounts that a recreate resets, which is why this lives here and not in the image —
# and both are written in place: `sed -i` renames, and renaming onto a bind mount fails with EBUSY.
gateway="$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')"
if [ -n "$gateway" ] && ! grep -q "^${gateway}[[:space:]]" /etc/hosts 2>/dev/null; then
    printf '%s\tdocker-gateway\n' "$gateway" >> /etc/hosts
fi
if [ -f /etc/resolv.conf ] && ! grep -q 'timeout:' /etc/resolv.conf 2>/dev/null; then
    awk '/^options /{print $0" timeout:1 attempts:2"; found=1; next} {print} END{if(!found) print "options timeout:1 attempts:2"}' \
        /etc/resolv.conf > /tmp/resolv.conf.new && cat /tmp/resolv.conf.new > /etc/resolv.conf && rm -f /tmp/resolv.conf.new
fi

# The daemon is the main process — exec so it becomes PID 1 and owns SIGTERM/SIGINT graceful shutdown.
#
# --report-on-fatalerror: a V8 fatal error (heap limit, native OOM) prints only to stderr and dies — and
# stderr lives in `docker logs`, which the next recreate erases. The diagnostic report lands on /history
# instead, where the next boot's death check (src/platform/boot-marker.ts) finds and names it — without this,
# a daemon that dies on a fatal error dies without a trace.
exec node --report-on-fatalerror --report-directory="$HISTORY_ROOT/logs" /opt/sandbox/dist/main.js
