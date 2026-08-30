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
    # EVERY SHARE THIS ENVIRONMENT OWNS IS STALE THE MOMENT THIS SCRIPT RUNS, so they are all released before
    # the agent comes up. This is the one place that can be systematic about it, and it has to be done here
    # rather than at each bind site, because there are three of them (the daemon's own name below, plus preview
    # and port names minted later by panels/preview-route.ts) and they all fail the same way.
    #
    # WHY THEY ARE STALE: a share lives on the hub, but the thing that SERVES it is a terminator — an open
    # connection from this box into the overlay. A container recreate (`docker rm -f` + `docker run`, which is
    # what every rebuild, update and provider change does) kills that connection without telling the hub, so
    # the share survives, still holding its hostname, pointing at an egress that no longer exists. The hub then
    # refuses to let the new agent bind the same name (409 shareConflict) while continuing to answer requests
    # for it with a dial that can never succeed.
    #
    # The old behaviour treated that 409 as "already bound, nothing to do", which is why a rebuilt sandbox came
    # up with NO share of its own and 502'd on every request — and since the sync transport rides that same
    # address (platform/sync-ssh.ts), desktop sync died with it while the workspace still looked healthy over
    # the loopback shortcut. Reclaiming one name at a time cannot fix that: the previews and ports hit it too.
    #
    # Deleting is safe precisely BECAUSE it is scoped to this environment: `zrok2 overview` lists only the
    # account this box was enabled with, the agent recreates every share from its own registry moments later,
    # and the names are deterministic, so what comes back is what was there. Failure is non-fatal — a hub that
    # cannot be reached here leaves the binds below to retry, which is where they already were.
    zrok_stale_tokens() {
        # The overview is a box-drawn table: turn the rules into a plain delimiter, drop the padding, then take
        # the share-token column of the Names rows. Those rows are `|<url>|<namespace>|<token>|<reserved>|...`,
        # so the filter is: a URL with a dot in it, a namespace that is actually present, and a 12-character
        # token. The namespace check is what keeps the Namespaces table above it out — its rows leave that
        # column empty and would otherwise offer up the literal name "public" as a share to delete.
        #
        # `length()` rather than a `{12}` interval on purpose: the image's awk is busybox, whose default regex
        # engine does not do interval expressions, and it fails by matching NOTHING rather than by erroring.
        zrok2 overview 2>/dev/null | sed 's/│/|/g; s/ //g' \
            | awk -F'|' '$2 ~ /\./ && $3 != "" && length($4) == 12 && $4 ~ /^[a-z0-9]+$/ { print $4 }'
    }
    for stale in $(zrok_stale_tokens); do
        echo "releasing stale share $stale from a previous container" >> "$HISTORY_ROOT/logs/zrok.log"
        zrok2 delete share "$stale" >> "$HISTORY_ROOT/logs/zrok.log" 2>&1 || true
    done
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
            # The sweep above should have made a 409 here impossible, so reaching this branch means the sweep
            # could not run — the hub was unreachable at boot, or a share was minted between the two. It is the
            # same reclaim, narrowed to the one name that matters most (this is the address the browser, the
            # platform's reachability probe and desktop sync all use), and it exists so that a sweep which
            # failed costs a slow start rather than a sandbox that is 502 until someone notices.
            #
            # Bounded at three: past that the loop stops deleting and just keeps retrying the bind, so a hub
            # that is merely slow is waited out rather than fought, and a delete/create fight cannot run away.
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
