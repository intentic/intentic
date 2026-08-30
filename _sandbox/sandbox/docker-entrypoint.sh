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
# One in-box agent, every flavor: `zrok2` enables against the self-hosted hub with the account token the
# platform minted for THIS sandbox (ZROK_TOKEN, born as a grant the platform can revoke but never
# impersonate — the Ziti identity below is created here and never leaves), then serves the daemon publicly at
# the `sandbox-<id>` name the browser already knows. That replaces the cloudflared sidecar container and its
# per-sandbox DNS records outright.
#
# The hub keeps NAMES and SHARES apart: a name is a hostname claimed in the namespace, a share is what answers
# on it. So each is claimed first (`create name`, 409 when it is already ours) and bound second (`share
# public -n <namespace>:<name>`). The long-lived process is the AGENT, not the share: `zrok2 agent start`
# holds every share this box publishes, which is why the daemon can add preview names later
# (panels/preview-route.ts) with two calls that return immediately instead of resident processes of its own.
#
# Enabling is idempotent-by-marker: the environment's identity lives on /history (the volume that outlives
# every recreate), so a restarted or rebuilt container re-attaches the SAME names rather than minting a
# second environment. The agent runs in a restart loop for the reason the sidecar had `--restart
# unless-stopped`: the overlay drops connections and must simply come back.
if [ -n "${ZROK_TOKEN:-}" ]; then
    export HOME="${HOME:-/root}"
    # Set here as well as below: the agent's state must land on the volume, and this block runs first.
    HISTORY_ROOT="${HISTORY_ROOT:-/history}"
    ZROK_STATE="$HISTORY_ROOT/zrok"
    mkdir -p "$ZROK_STATE" "$HISTORY_ROOT/logs"
    # The agent keeps its environment (its Ziti identity, its share registry) in $HOME/.zrok2 with no way to
    # point it elsewhere — so that path becomes a link onto the volume, which is what survives a recreate. Any
    # process that later runs `zrok2` (the daemon attaching preview names) inherits the same HOME and lands on
    # the same environment, which is the point.
    [ -e "$HOME/.zrok2" ] || ln -s "$ZROK_STATE" "$HOME/.zrok2"
    # The v2 binary reads ZROK2_*; the platform hands the grant down under ZROK_* (its own vocabulary, shared
    # with the run contract and the compose file). Without this the CLI silently talks to api-v2.zrok.io.
    [ -n "${ZROK_API:-}" ] && export ZROK2_API_ENDPOINT="$ZROK_API"
    export ZROK2_HEADLESS=true
    if [ ! -f "$ZROK_STATE/environment.json" ]; then
        # --headless or the TUI opens /dev/tty, which a container does not have: enable then fails AFTER
        # creating the environment, which reads as a failure that isn't one.
        zrok2 enable "$ZROK_TOKEN" --headless --description "${SANDBOX_NAME:-intentic-sandbox}" \
            >> "$HISTORY_ROOT/logs/zrok.log" 2>&1 || echo "zrok enable failed — see $HISTORY_ROOT/logs/zrok.log" >&2
    fi
    (
        while :; do
            zrok2 agent start >> "$HISTORY_ROOT/logs/zrok.log" 2>&1 || true
            sleep 2
        done
    ) &
    # The daemon's own name is the address the browser already knows: sandbox-<id>, derived from the connect
    # token by the platform and handed down as SANDBOX_PUBLIC_URL, so its leftmost label is the share name.
    if [ -n "${SANDBOX_PUBLIC_URL:-}" ]; then
        daemon_name="$(printf '%s' "$SANDBOX_PUBLIC_URL" | sed -e 's#^https\?://##' -e 's#/.*##' -e 's#\..*##')"
        zrok_namespace="${ZROK_NAMESPACE:-public}"
        (
            # Until the share is bound. The agent needs a moment to come up, so the loop is expected to fail a
            # few times first; what it must NOT do is give up when the name is taken.
            #
            # "already in use" USED TO COUNT AS SUCCESS, on the reasoning that the holder is this sandbox's own
            # share from a previous boot, so the address works either way. The first half is right and the
            # second is not. A container recreate (`docker rm -f` + `docker run`, what every rebuild does)
            # never releases anything: the hub keeps the old share, still holding the name, with a terminator
            # pointing at an edge connection that died with the old container. So the new agent asks for its
            # own hostname, is told 409 shareConflict, treats that as done, and the sandbox comes up with NO
            # share of its own — reachable at an address whose only terminator is dead. Every request to it
            # 502s, the daemon's own reachability probe says "not routing here yet" forever, and because the
            # SYNC transport rides that same address (platform/sync-ssh.ts), desktop sync dies with it while
            # the workspace itself still looks fine over the loopback shortcut. That is the whole failure, and
            # it arrives on every rebuild.
            #
            # So a taken name is RECLAIMED instead. `zrok2 overview` is the only listing the account has, and
            # it maps each name to the share token holding it; deleting that share frees the name for the bind
            # on the next pass. Only ever this sandbox's OWN account is listed, so there is nothing here that
            # could reach another sandbox's share.
            #
            # Bounded, because a reclaim that keeps failing is a different problem: after three tries the loop
            # stops deleting and just keeps retrying the bind, so a hub that is merely slow is waited out
            # rather than fought, and a delete/create fight can never run forever.
            reclaims=0
            while :; do
                zrok2 create name "$daemon_name" --namespace-token "$zrok_namespace" \
                    >> "$HISTORY_ROOT/logs/zrok.log" 2>&1 || true
                if zrok2 share public "http://127.0.0.1:${SANDBOX_PORT:-8787}" --backend-mode proxy \
                    --name-selection "$zrok_namespace:$daemon_name" >> "$HISTORY_ROOT/logs/zrok.log" 2>&1; then
                    break
                fi
                if [ "$reclaims" -lt 3 ] && tail -n 20 "$HISTORY_ROOT/logs/zrok.log" 2>/dev/null | grep -q "already in use"; then
                    reclaims=$((reclaims + 1))
                    # The table is box-drawn: turn the rules into a plain delimiter, drop the padding, then the
                    # row whose URL starts with our name yields the token of the share sitting on it.
                    stale="$(zrok2 overview 2>/dev/null | sed 's/│/|/g; s/ //g' \
                        | awk -F'|' -v n="$daemon_name" '$2 ~ ("^" n "\\.") { print $4; exit }')"
                    if [ -n "$stale" ]; then
                        echo "reclaiming '$daemon_name' from stale share $stale (attempt $reclaims)" \
                            >> "$HISTORY_ROOT/logs/zrok.log"
                        zrok2 delete share "$stale" >> "$HISTORY_ROOT/logs/zrok.log" 2>&1 || true
                    fi
                fi
                sleep 2
            done
        ) &
    fi
fi

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
