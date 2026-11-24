#!/usr/bin/env bash
# Provision a native Debian/Ubuntu host as a CI runner host for intentic/intentic (docs/ops/ci-runner.md, "A Linux host").
# Idempotent: re-run to repair or to add instances. Registering a new instance needs a repository registration token in
# RUNNER_TOKEN; instances already configured are left as they are and need none. The runners are kept, and their caches,
# Docker and the test-memory pool bounded, by the machine agent's root service (`intentic-machine ci-fleet install`),
# so the person's intentic agent must be installed first.
#
#   sudo RUNNER_TOKEN=<token> ./setup-linux-runner.sh --name z440 --workers 3 --light 1 --user radarsu --test-slots 9
set -euo pipefail

URL=https://github.com/intentic/intentic
NAME=$(hostname -s)
WORKERS=2
LIGHT=0
RUNNER_USER=${SUDO_USER:-}
# The workflows size the shared test pool at TEST_SLOTS: "16" one-GiB slots, for the 26 GB omen VM. A smaller host
# keeps only this many usable: the fleet service holds the locks on the rest (`ci-fleet install --slots-usable`).
TEST_SLOTS_USABLE=
LIB=/usr/local/lib/intentic-ci

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
HOME_DIR=$(getent passwd "$RUNNER_USER" | cut -d: -f6)
# The fleet service is the person's intentic agent, installed as root from its signed release; the agent's own binary
# only sets it up. Where the agent runs as root (z440), its binary is root's.
AGENT="$HOME_DIR/.intentic/machine/bin/intentic-machine"
[ -x "$AGENT" ] || AGENT=/root/.intentic/machine/bin/intentic-machine
[ -x "$AGENT" ] || die "no intentic agent at $HOME_DIR/.intentic/machine/bin/intentic-machine or /root/.intentic/machine/bin/intentic-machine: install the intentic agent on this computer first (it runs the CI fleet service)"

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

# -- docker and runner logs: what wsl-maintenance.ps1 does on omen, which no Windows task does here -----------------
# The fleet service's host prune (`--prune` below; _devices/machine src/ci-fleet/prune/) says what it removes and when.
# dockerd itself caps what grows between its passes: each container's log, and the default builder's cache.
# live-restore keeps job containers running through a docker upgrade or restart.
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
        # The fleet service's host prune restarts docker at its first pass with no job running.
        : > /var/lib/intentic-ci/docker-restart-pending
        say "wrote /etc/docker/daemon.json; docker restarts at the next idle prune pass"
    else
        systemctl restart docker
        say "wrote /etc/docker/daemon.json and restarted docker"
    fi
fi
# The journal holds every runner's and the fleet service's output.
install -d /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=2G\n' > /etc/systemd/journald.conf.d/90-intentic-ci.conf
systemctl restart systemd-journald
# The first version of this script generated a docker-prune.sh with an hourly timer.
if [ -f /etc/systemd/system/intentic-ci-docker-prune.timer ]; then
    systemctl disable --now intentic-ci-docker-prune.timer >/dev/null 2>&1
    rm -f /etc/systemd/system/intentic-ci-docker-prune.service /etc/systemd/system/intentic-ci-docker-prune.timer "$LIB/docker-prune.sh"
fi

# -- the fleet service: keeper, janitor, host prune and the test-memory pool, shrunk to this host ---------------------
# One root service in place of the janitor's and the prune's timers and the slot-holding unit, which it disables. It
# starts a runner unit that went down, caps runner temp, /ci-cache and buildkit state hourly, prunes Docker every 15
# minutes, and holds test-memory-pool slots TEST_SLOTS_USABLE+1..16 so jobs here take only the first ones (the gate
# band, slot 1 up, stays whole).
"$AGENT" ci-fleet install --user "$RUNNER_USER" --prune ${TEST_SLOTS_USABLE:+--slots-usable "$TEST_SLOTS_USABLE"}

say "docker $(docker version --format '{{.Server.Version}}'), runner $version, $(df -h --output=avail / | tail -n1 | tr -d ' ') free on /"
say "fleet service: $(systemctl is-active intentic-ci-fleet.service)${TEST_SLOTS_USABLE:+; test slots usable: $TEST_SLOTS_USABLE of 16}; \`intentic-machine ci-fleet status\` shows the runners and its passes"
