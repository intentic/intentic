#!/bin/sh
set -e

# THE HOSTED FLAVOR — SANDBOX_VM=1 means this image IS the whole machine (a microVM booting it, one
# persistent volume at /data), not a container among containers. Everything VM-shaped happens here and runs
# FIRST: the moment anything below touches /work or /history they must already be the volume, because the
# machine's root filesystem is rebuilt from the image on every start and only /data survives. The layout
# mirrors @intentic/sandbox-run/fly (FLY_VOLUME_LAYOUT) — change one, change both.
if [ "${SANDBOX_VM:-}" = "1" ]; then
    # The image's WORKDIR is /work, so PID 1 starts with its cwd inside the directory this block replaces.
    # Removing that directory in place leaves the process holding an unlinked cwd: the first Node call then
    # dies in process.cwd() with ENOENT (uv_cwd), and Fly exhausts the machine's restart allowance. Step out
    # before replacing it, then enter the persistent target once the link exists.
    cd /
    mkdir -p /data/work /data/history /data/docker

    # The image bakes /work (its WORKDIR) and /history as plain, EMPTY directories (nothing is seeded at
    # build time — the daemon scaffolds at runtime), so linking them onto the volume loses nothing and keeps
    # every "/work" in the product literally true on a VM. Idempotent: a restart finds the links and moves on.
    if [ ! -L /work ]; then
        rmdir /work 2>/dev/null || rm -rf /work
        ln -s /data/work /work
    fi
    if [ ! -L /history ]; then
        rmdir /history 2>/dev/null || rm -rf /history
        ln -s /data/history /history
    fi

    # The nested Docker Engine's state must outlive the ephemeral rootfs. Merged, never overwritten — the GPU
    # fragment's nvidia runtime entry (docker.ts's daemon.json stance) would be silently lost to a wholesale
    # write. No jq dependency games: the image bakes node, and node is already the daemon's runtime.
    mkdir -p /etc/docker
    node -e '
        const fs = require("fs");
        const path = "/etc/docker/daemon.json";
        let current = {};
        try { current = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
        fs.writeFileSync(path, JSON.stringify({ ...current, "data-root": "/data/docker" }, null, 4) + "\n");
    '

    cd /work
fi

# ── HOW THIS SANDBOX IS REACHED ──────────────────────────────────────────────────────────────────────────
#
# NOT FROM HERE, any more. ~150 lines used to sit at this spot enabling a zrok environment, claiming the
# `sandbox-<id>` name, binding a share to it, and reclaiming whatever the previous container had left holding
# that name — because on the hub, reachability was STATE: an account per sandbox, a name, a share, and a
# terminator that a `docker rm -f` killed without telling anyone, so a recreated box came up 502 on its own
# address and fought its dead predecessor for the name.
#
# The edge the platform runs now answers the question that state existed for — "which sandbox may serve this
# hostname?" — by PARSING it: every public name ends in the sandbox's own 12-hex id (sandbox-contract's
# hostnames.ts), so ownership is arithmetic and the only thing to provision is a signed grant naming that id.
# Nothing to enable, claim, bind or reclaim, and a second tunnel for an id simply displaces the first.
#
# What remains is one outbound dial, and it belongs to the DAEMON rather than to this script — it reads the
# grant and the edge out of its own environment (ingress-contract.ts's ENV_SANDBOX_GRANT / ENV_INGRESS_URL),
# which is why the entrypoint no longer has a reachability step at all.

# sshd backs the local-sync path: the laptop's Mutagen connects over SSH and auto-injects its agent, which
# reads/writes /work. It is reached on 127.0.0.1 here — the daemon carries the stream in from its own HTTPS
# surface (platform/sync-ssh.ts), so nothing about this listener depends on how the sandbox is reachable, and
# no port of it is ever published. Key-only auth; the machine's public key is enrolled at runtime by the
# daemon's POST /system/authorized-key (authorized by a browser-minted pairing, or the owner's Google token).

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

# The terminal's zsh writes its history here (HISTFILE, image .zshrc) so autosuggestions survive a rebuild
# along with everything else on this volume. zsh creates the FILE but not its directory, and the first shell
# after a rebuild can open before anything else has touched /history — so the directory is made once, here,
# rather than raced for by every shell.
mkdir -p "$HISTORY_ROOT/shell"

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
