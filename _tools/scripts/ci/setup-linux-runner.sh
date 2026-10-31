#!/usr/bin/env bash
# Provision a native Debian/Ubuntu host as a CI runner host for intentic/intentic (docs/ops/ci-runner.md, "A Linux host").
# Idempotent: re-run to repair, to add instances, or to install a newer janitor. Registering a new instance needs a
# repository registration token in RUNNER_TOKEN; instances already configured are left as they are and need none.
#
#   sudo RUNNER_TOKEN=<token> ./setup-linux-runner.sh --name z440 --workers 3 --light 1 --user radarsu --test-slots 9
set -euo pipefail

URL=https://github.com/intentic/intentic
NAME=$(hostname -s)
WORKERS=2
LIGHT=0
RUNNER_USER=${SUDO_USER:-}
# The workflows size the shared test pool at TEST_SLOTS: "16" one-GiB slots, for the 26 GB omen VM. A smaller host
# keeps only this many usable by holding the locks on the rest for good (hold-test-slots.sh below).
TEST_SLOTS_USABLE=
# The workflows' TEST_SLOTS; slots above TEST_SLOTS_USABLE up to this one are held.
TEST_SLOTS_TOTAL=16
LIB=/usr/local/lib/intentic-ci
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

say() { echo "setup-linux-runner: $*"; }
die() { say "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --name) NAME=$2; shift 2 ;;
        --workers) WORKERS=$2; shift 2 ;;
        --light) LIGHT=$2; shift 2 ;;
        --user) RUNNER_USER=$2; shift 2 ;;
        --test-slots) TEST_SLOTS_USABLE=$2; shift 2 ;;
        --url) URL=$2; shift 2 ;;
        *) die "unknown argument $1" ;;
    esac
done

[ "$(id -u)" -eq 0 ] || die "run me as root: docker, systemd units and /ci-cache are root's"
[ -n "$RUNNER_USER" ] && id "$RUNNER_USER" >/dev/null 2>&1 || die "--user must name the existing account the runners run as"
for f in fleet-janitor.sh linux-host-prune.sh; do [ -f "$HERE/$f" ] || die "$f must sit next to this script"; done
HOME_DIR=$(getent passwd "$RUNNER_USER" | cut -d: -f6)

# -- packages and docker -------------------------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git jq sudo tar >/dev/null
if ! command -v docker >/dev/null; then
    say "installing Docker Engine from download.docker.com"
    # In a subshell: os-release sets NAME, which would replace the runner name prefix.
    os=$(. /etc/os-release && echo "$ID $VERSION_CODENAME")
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/${os% *}/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${os% *} ${os#* } stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null
usermod -aG docker "$RUNNER_USER"

# Watch-mode tests and the vite builds open more inotify watches than a stock kernel allows per user.
cat > /etc/sysctl.d/90-intentic-ci.conf <<'EOF'
fs.inotify.max_user_watches=1048576
fs.inotify.max_user_instances=1024
EOF
sysctl -q --system
# A runner host that suspends is offline, which GitHub cannot tell from broken.
systemctl mask -q sleep.target suspend.target hibernate.target hybrid-sleep.target

# Jobs mount it; on the runners' filesystem so pnpm hard-links from its store.
install -d -o "$RUNNER_USER" -g "$RUNNER_USER" /ci-cache
install -d "$LIB" /var/cache/intentic-ci

# -- runner instances ----------------------------------------------------------------------------------------------
version=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')
[ -n "$version" ] && [ "$version" != null ] || die "could not read the latest actions/runner release"
tarball=/var/cache/intentic-ci/actions-runner-linux-x64-$version.tar.gz
[ -f "$tarball" ] || curl -fsSL -o "$tarball" "https://github.com/actions/runner/releases/download/v$version/actions-runner-linux-x64-$version.tar.gz"

deps_done=0
# instance <dir suffix> <runner name> <labels>
instance() {
    local dir="$HOME_DIR/actions-runner-$1" name=$2 labels=$3
    if [ -f "$dir/.runner" ]; then
        say "$name: already configured in $dir"
    else
        [ -n "${RUNNER_TOKEN:-}" ] || die "$name is not configured yet and RUNNER_TOKEN is empty (POST /repos/intentic/intentic/actions/runners/registration-token)"
        install -d -o "$RUNNER_USER" -g "$RUNNER_USER" "$dir"
        sudo -u "$RUNNER_USER" tar -xzf "$tarball" -C "$dir"
        if [ "$deps_done" = 0 ]; then "$dir/bin/installdependencies.sh" >/dev/null; deps_done=1; fi
        sudo -u "$RUNNER_USER" -H bash -c "cd '$dir' && ./config.sh --unattended --replace --url '$URL' --token '$RUNNER_TOKEN' --name '$name' --labels '$labels'"
    fi
    if ! (cd "$dir" && ./svc.sh status 2>/dev/null | grep -q 'active (running)'); then
        (cd "$dir" && { [ -f .service ] || ./svc.sh install "$RUNNER_USER" >/dev/null; } && ./svc.sh start >/dev/null)
    fi
    say "$name: $(cd "$dir" && ./svc.sh status 2>/dev/null | grep -o 'active (running)' || echo 'NOT running')"
}
for n in $(seq 1 "$WORKERS"); do instance "$n" "$NAME-worker-$n" intentic,desktop; done
# Light instances only ever take the pipeline's two roots; see .github/actionlint.yaml.
for n in $(seq 1 "$LIGHT"); do instance "light-$n" "$NAME-light-$n" intentic-light; done

# -- janitor: the WSL fleet's, unchanged (its defaults already match /ci-cache and ~/actions-runner-*) ---------------
install -m 0755 "$HERE/fleet-janitor.sh" "$LIB/fleet-janitor.sh"
cat > /etc/systemd/system/intentic-ci-janitor.service <<EOF
[Unit]
Description=Intentic CI fleet janitor: caps runner temp, /ci-cache and buildkit state ($LIB/fleet-janitor.sh)

[Service]
Type=oneshot
ExecStart=$LIB/fleet-janitor.sh
Nice=19
IOSchedulingClass=idle
TimeoutStartSec=3h
EOF
cat > /etc/systemd/system/intentic-ci-janitor.timer <<'EOF'
[Unit]
Description=Run the Intentic CI fleet janitor hourly

[Timer]
OnBootSec=20min
OnUnitActiveSec=1h
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
EOF

# -- docker and runner logs: what wsl-maintenance.ps1 does on omen, which no Windows task does here -----------------
# linux-host-prune.sh says what it removes and when. dockerd itself caps what grows between its passes: each
# container's log, and the default builder's cache. live-restore keeps job containers running through a docker
# upgrade or restart.
install -m 0755 "$HERE/linux-host-prune.sh" "$LIB/linux-host-prune.sh"
install -d /etc/docker /var/lib/intentic-ci
daemon_json='{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "3" },
  "live-restore": true,
  "builder": {
    "gc": { "enabled": true, "defaultReservedSpace": "5GB", "defaultMaxUsedSpace": "40GB", "defaultMinFreeSpace": "100GB" }
  }
}'
if [ "$(cat /etc/docker/daemon.json 2>/dev/null)" != "$daemon_json" ]; then
    printf '%s\n' "$daemon_json" > /etc/docker/daemon.json
    if pgrep -x Runner.Worker >/dev/null; then
        # The prune timer restarts docker at its first pass with no job running.
        : > /var/lib/intentic-ci/docker-restart-pending
        say "wrote /etc/docker/daemon.json; docker restarts at the next idle prune pass"
    else
        systemctl restart docker
        say "wrote /etc/docker/daemon.json and restarted docker"
    fi
fi
# The journal holds every runner's and timer's output.
install -d /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=2G\n' > /etc/systemd/journald.conf.d/90-intentic-ci.conf
systemctl restart systemd-journald
# The first version of this script generated a docker-prune.sh with an hourly timer.
if [ -f /etc/systemd/system/intentic-ci-docker-prune.timer ]; then
    systemctl disable --now intentic-ci-docker-prune.timer >/dev/null 2>&1
    rm -f /etc/systemd/system/intentic-ci-docker-prune.service /etc/systemd/system/intentic-ci-docker-prune.timer "$LIB/docker-prune.sh"
fi
cat > /etc/systemd/system/intentic-ci-prune.service <<EOF
[Unit]
Description=Intentic CI: prune docker images, containers, volumes, build cache and runner logs ($LIB/linux-host-prune.sh)
After=docker.service

[Service]
Type=oneshot
ExecStart=$LIB/linux-host-prune.sh
Nice=19
IOSchedulingClass=idle
TimeoutStartSec=1h
EOF
cat > /etc/systemd/system/intentic-ci-prune.timer <<'EOF'
[Unit]
Description=Run the Intentic CI host prune every 15 minutes

[Timer]
OnBootSec=10min
OnUnitActiveSec=15min
RandomizedDelaySec=2min

[Install]
WantedBy=timers.target
EOF

# -- the test-memory pool, shrunk to this host ------------------------------------------------------------------------
# test-memory-pool.mjs flocks /ci-cache/test-slots/slot-N; a slot held here is one no job can take, so holding
# slots TEST_SLOTS_USABLE+1..TEST_SLOTS_TOTAL leaves the workflows' pool the size of this machine. The gate band
# (slot 1 up) stays whole: it is the low numbers that are reserved.
cat > "$LIB/hold-test-slots.sh" <<'EOF'
#!/usr/bin/env bash
# GENERATED by _tools/scripts/ci/setup-linux-runner.sh -- holds test-memory-pool slots FIRST..LAST for as long as it runs.
dir=$1 first=$2 last=$3
mkdir -p "$dir"
for i in $(seq "$first" "$last"); do
    exec {fd}>>"$dir/slot-$i"
    flock "$fd"
done
echo "holding $dir/slot-$first..slot-$last"
exec sleep infinity
EOF
chmod 755 "$LIB/hold-test-slots.sh"
if [ -n "$TEST_SLOTS_USABLE" ] && [ "$TEST_SLOTS_USABLE" -lt "$TEST_SLOTS_TOTAL" ]; then
    cat > /etc/systemd/system/intentic-ci-test-slots.service <<EOF
[Unit]
Description=Intentic CI: keep $TEST_SLOTS_USABLE of the workflows' $TEST_SLOTS_TOTAL test-memory slots usable on this host

[Service]
ExecStart=$LIB/hold-test-slots.sh /ci-cache/test-slots $((TEST_SLOTS_USABLE + 1)) $TEST_SLOTS_TOTAL
Restart=always

[Install]
WantedBy=multi-user.target
EOF
    slots_unit=intentic-ci-test-slots.service
else
    rm -f /etc/systemd/system/intentic-ci-test-slots.service
    slots_unit=
fi

systemctl daemon-reload
systemctl enable --now intentic-ci-janitor.timer intentic-ci-prune.timer >/dev/null
if [ -n "$slots_unit" ]; then systemctl enable "$slots_unit" >/dev/null 2>&1; systemctl restart "$slots_unit"; fi

say "docker $(docker version --format '{{.Server.Version}}'), runner $version, $(df -h --output=avail / | tail -n1 | tr -d ' ') free on /"
say "timers: $(systemctl is-active intentic-ci-janitor.timer) janitor, $(systemctl is-active intentic-ci-prune.timer) host prune${slots_unit:+; test slots usable: $TEST_SLOTS_USABLE of $TEST_SLOTS_TOTAL ($(systemctl is-active "$slots_unit"))}"
