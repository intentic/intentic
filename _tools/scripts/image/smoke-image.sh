#!/usr/bin/env bash
# Boot each freshly pushed architecture before moving tags: production dependencies differ from the development install.
# Assert running state, health, converged boot and baked/seeded starter; fail immediately on failed boot steps or repeated daemon crashes.
# Probe with the image's Node, without host curl/jq. netd can restart the daemon without stopping the container, so inspect both.
# Loopback mode uses no auth/public URL, volumes, published ports or privileges; only a Docker daemon is required.
set -euo pipefail

[ "$#" -gt 0 ] || { echo "usage: smoke-image.sh <image-ref> [<image-ref>...]" >&2; exit 2; }

# The pull below goes through image-pull.sh, which wraps the shared registry retry — a conversation with
# ghcr.io that the network drops is the same "wait and try again" whichever way the bytes were moving — and
# adds the half a pull has that a push does not: the unpack into this runner's image store, which is the
# daemon's fault and not the registry's when it breaks (that file has the release it cost). The retry defaults
# are sized for GHCR's rate-limit window, which is a clock worth waiting out in minutes; what drops a pull here
# is a TCP connect that clears in seconds, so these gaps are short. Set before the source so an operator's own
# values still win.
: "${REGISTRY_RETRY_ATTEMPTS:=4}"
: "${REGISTRY_RETRY_DELAY:=15}"
. "$(dirname "$0")/../lib/image-pull.sh"

# The boot budget alone — the pull is a separate step below and its own clock — kept generous because these
# runners boot cold while they are still busy with the build behind them, and testcontainers gives the same
# boot 180s.
TIMEOUT="${SMOKE_TIMEOUT:-240}"

# Drop each image from the local store once it has been smoked. OFF by default, because on the self-hosted
# fleet the pulled layers are a warm parent for the next pipeline's build and throwing them away is pure loss.
# ON for the GitHub-hosted arm runners: buildx pushes from its own cache without populating the docker store,
# so the pull below fetches a second ~5 GB copy of an image that runner has just built — and a hosted runner's
# disk is the one place that matters.
RMI="${SMOKE_RMI:-0}"

# SMOKE_PULL=0 boots what this machine's docker store already holds and fetches nothing: the image was built here
# with `--load` and was never pushed (publish-images.sh's PUSH=0, ci.yml's `images-dry`), so the registry has no such
# tag to give. A ref the store does not hold is then a failed build, said as one, rather than a pull error.
PULL="${SMOKE_PULL:-1}"

# Every container this run started, so a cancelled job (the one exit path the per-verdict cleanup below cannot
# reach) does not leave a 5 GB box running on a shared runner. Names never contain spaces, so the split is safe.
STARTED=""
trap 'for leftover in $STARTED; do docker rm -f "$leftover" >/dev/null 2>&1 || true; done' EXIT

# The one probe, as bytes rather than an escaped one-liner — a quoted heredoc so nothing here is expanded by
# the shell on its way into the container.
PROBE="$(
    cat <<'JS'
const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const fail = (code, why) => { console.error(why); process.exit(code); };
// Agent programs must get the language their commands assume. A few zsh options cannot supply Bash semantics.
// Exercise the image's defaults, including a child choosing its shell again; never substitute a hard-coded Bash
// executable for the value being tested. These are terminal failures, so a broken image is not retried as slow boot.
const checkShells = () => {
    for (const key of ["SHELL", "CLAUDE_CODE_SHELL"]) {
        if (process.env[key] !== "/bin/bash") fail(2, `${key} must select /bin/bash for agent commands, got ${JSON.stringify(process.env[key])}`);
    }
    const command = String.raw`
files=$(printf 'first\nsecond\n')
set -- $files
[ "$#" = 2 ] || exit 11
[ "$1" = first ] && [ "$2" = second ] || exit 12
set -- intentic-smoke-no-match-*.missing =intentic-smoke-no-command
[ "$#" = 2 ] && [ "$1" = 'intentic-smoke-no-match-*.missing' ] && [ "$2" = '=intentic-smoke-no-command' ] || exit 13
files=(first second)
[ "$files" = first ] || exit 14
files[0]=zero
[ "$files" = zero ] || exit 14
"$SHELL" -c 'values="first second"; set -- $values; [ "$#" = 2 ] && [ -n "$BASH_VERSION" ]' || exit 15
printf 'bash semantics ok'
`;
    for (const key of ["SHELL", "CLAUDE_CODE_SHELL"]) {
        for (const flag of ["-c", "-lc"]) {
            const result = spawnSync(process.env[key], [flag, command], { encoding: "utf8", timeout: 10000 });
            if (result.status !== 0 || result.stdout !== "bash semantics ok") {
                fail(2, `${key} ${flag} failed the agent shell probe: ${result.error?.message ?? result.stderr} (exit ${result.status})`);
            }
        }
    }
    // Use a private server: its defaults must come from the shipped config, independent of the daemon's tmux server.
    const socket = `intentic-smoke-shell-${process.pid}`;
    const tmux = (args) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8", timeout: 10000 });
    let problem;
    try {
        const started = tmux(["-f", "/root/.tmux.conf", "new-session", "-d", "-s", "shell"]);
        if (started.status !== 0) problem = `cannot start the image's terminal: ${started.error?.message ?? started.stderr}`;
        for (const [key, expected] of [["default-shell", "/bin/bash"], ["default-command", "zsh"]]) {
            const result = tmux(["show-options", "-gv", key]);
            if (result.status !== 0 || result.stdout.trim() !== expected) problem ??= `tmux ${key} must be ${expected}, got ${JSON.stringify(result.stdout)}`;
        }
    } finally {
        tmux(["kill-server"]);
    }
    if (problem !== undefined) fail(2, problem);
};
(async () => {
    // netd answers its vitals itself, whatever state the daemon is in. A daemon it has restarted three times and that is
    // down again is crashing on every start, and /health would only be retried until the timeout (2026-10-06: a daemon
    // that could not load a package). Terminal. No vitals at all is an image from before netd, or netd not listening
    // yet, which the /health read below reports in its own words.
    const vitals = await fetch("http://127.0.0.1:8787/system/vitals", { signal: AbortSignal.timeout(2000) })
        .then((answer) => (answer.ok ? answer.json() : undefined))
        .catch(() => undefined);
    if (vitals !== undefined && vitals.node !== "up" && Number(vitals.restarts) >= 3) {
        fail(2, `the daemon keeps crashing: netd restarted it ${vitals.restarts} times in ten minutes and it is down again`);
        return;
    }
    let res;
    try {
        res = await fetch("http://127.0.0.1:8787/health", { signal: AbortSignal.timeout(5000) });
    } catch (error) {
        fail(1, `no answer on 8787 yet: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }
    if (!res.ok) {
        fail(1, `/health answered ${res.status}`);
        return;
    }
    const health = await res.json();
    const steps = health?.boot?.steps ?? [];
    // Terminal, so exit 2: the caller stops polling and reports rather than waiting out the timeout.
    const failed = steps.filter((step) => step.state === "failed").map((step) => step.label ?? step.key);
    if (failed.length > 0) {
        fail(2, `boot steps FAILED: ${failed.join(", ")}`);
        return;
    }
    if (health?.ok !== true) {
        fail(1, `/health reports ok: ${JSON.stringify(health?.ok)}`);
        return;
    }
    if (health?.boot?.ready !== true) {
        const pending = steps.filter((step) => step.state !== "done").map((step) => step.label ?? step.key);
        fail(1, `still converging: ${pending.join(", ") || "(no step detail)"}`);
        return;
    }
    /* Verify that the image bakes and first boot seeds the starter site. */
    let starter;
    try {
        starter = await import(pathToFileURL(require.resolve("@intentic/sandbox-contract/state/starter", { paths: ["/opt/sandbox"] })).href);
    } catch (error) {
        // Terminal and named: an unreadable contract module is a pruned or unresolvable package, not a slow
        // boot, and retrying it until the timeout would report "still not healthy" over a daemon that is
        // perfectly alive.
        fail(2, `cannot read the starter contract from the image: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }
    const { STARTER_APP, STARTER_REPO } = starter;
    if (typeof STARTER_APP !== "string" || typeof STARTER_REPO !== "string") {
        // The contract loaded but no longer names the starter site — a rename that reached the package and not
        // its readers, which `existsSync(join(dir, undefined))` would otherwise report as a missing bake.
        fail(2, `the contract names no starter site: STARTER_REPO=${JSON.stringify(STARTER_REPO)} STARTER_APP=${JSON.stringify(STARTER_APP)}`);
        return;
    }
    if (!existsSync(join("/opt/starter/_apps", STARTER_APP))) {
        fail(2, `the image bakes no starter site: /opt/starter/_apps/${STARTER_APP} is absent`);
        return;
    }
    const seeded = join(process.env.WORKSPACE_ROOT ?? "/work", STARTER_REPO, "_apps", STARTER_APP);
    if (!existsSync(seeded)) {
        fail(2, `the daemon converged but seeded no starter site: ${seeded} is absent (a fresh workspace must open with one)`);
        return;
    }
    checkShells();
    console.log(`ok · profile=${health.profile} · ${steps.length} boot step(s) done · starter site seeded · agent shells checked`);
})();
JS
)"

smoke() { # <image-ref>
    local image="$1"
    # One container name per image per run: two refs in one invocation must not collide, and a re-run on the
    # same runner must not trip over a leftover.
    local name
    name="intentic-smoke-$(printf '%s' "$image" | tr -c 'a-zA-Z0-9' '-' | tail -c 40)-$$"
    local out="" rc=0 deadline

    echo "==> smoking $image"

    # THE PULL IS ITS OWN STEP, AND IT RETRIES. `docker run` pulls an image the runner does not hold, which on
    # this pipeline is always: buildx pushed these bytes straight from its own cache and never populated the
    # docker image store. That implicit pull is the one part of this gate that can fail for reasons the image
    # knows nothing about, and on 2026-09-12 it took the 1.254.1 release down — the amd64 half died on
    # `dial tcp 140.82.121.33:443: connectex: A connection attempt failed`, twenty seconds before the core half
    # pulled its 5 GB off the same registry without a complaint.
    #
    # Left inside `docker run`, that failure was also MIS-DIAGNOSED. The run exits without creating anything,
    # the loop below finds no container and blames the daemon — "the container EXITED (code ?) — the daemon
    # never came up" — and then dumps logs that say "No such container". Every word of that points at the image
    # under test, and none of it was true. Pulling here names the registry as the registry — and, since
    # 1.285.0 died on the unpack rather than the download, names this runner's image store as itself.
    if [ "$PULL" = "0" ]; then
        if ! docker image inspect "$image" >/dev/null 2>&1; then
            echo "  ✗ $image is not in this machine's docker store, and SMOKE_PULL=0 fetches nothing: the build that should have loaded it did not" >&2
            return 1
        fi
    elif ! image_pull "$image"; then
        return 1
    fi

    docker rm -f "$name" >/dev/null 2>&1 || true
    STARTED="$STARTED $name"
    if ! docker run -d --name "$name" "$image" >/dev/null; then
        echo "  ✗ the image is on this runner but no container could be created from it" >&2
        return 1
    fi

    # `docker logs` is the whole diagnosis for a daemon that died on import — the stack trace is on stderr and
    # nowhere else — so the container is removed here rather than with `--rm`, which would take the logs with it.
    report_and_clean() {
        echo "--- docker logs $image (last 200 lines) ---" >&2
        docker logs --tail 200 "$name" >&2 || true
        echo "--- end logs ---" >&2
        docker rm -f "$name" >/dev/null 2>&1 || true
    }

    deadline=$(( $(date +%s) + TIMEOUT ))
    while :; do
        if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != "true" ]; then
            echo "  ✗ the container EXITED (code $(docker inspect -f '{{.State.ExitCode}}' "$name" 2>/dev/null || echo '?')) — the daemon never came up" >&2
            report_and_clean
            return 1
        fi

        # netd's line for each restart, on the container's stderr beside the daemon's own: a daemon that dies before it
        # reaches netd leaves no port open for the probe below to ask, and would be retried to the timeout (2026-10-06:
        # 240 s on an image whose daemon could not load a package, netd restarting it every few seconds throughout).
        crashes="$(docker logs "$name" 2>&1 >/dev/null | grep -c 'the daemon crashed; restarting it' || true)"
        if [ "${crashes:-0}" -ge 3 ]; then
            echo "  ✗ the daemon keeps crashing: netd restarted it ${crashes} times; last: $(docker logs "$name" 2>&1 >/dev/null | grep 'Error' | tail -n 1)" >&2
            report_and_clean
            return 1
        fi

        out="$(docker exec "$name" node -e "$PROBE" 2>&1)" && rc=0 || rc=$?
        case "$rc" in
            0)
                echo "  ✓ ${out}"
                docker rm -f "$name" >/dev/null 2>&1 || true
                return 0
                ;;
            2)
                echo "  ✗ ${out}" >&2
                report_and_clean
                return 1
                ;;
            126 | 127)
                # node is not on PATH in this image at all — permanent, and never what a booting daemon looks like.
                echo "  ✗ the image carries no usable node: ${out}" >&2
                report_and_clean
                return 1
                ;;
        esac

        if [ "$(date +%s)" -ge "$deadline" ]; then
            echo "  ✗ still not healthy after ${TIMEOUT}s: ${out}" >&2
            report_and_clean
            return 1
        fi
        sleep 2
    done
}

failures=0
for image in "$@"; do
    smoke "$image" || failures=$((failures + 1))
    # After the verdict, never before it: a failed smoke still wants its logs, and those were already printed.
    if [ "$RMI" = "1" ]; then
        docker image rm "$image" >/dev/null 2>&1 || true
    fi
done

echo
if [ "$failures" -gt 0 ]; then
    echo "==> $failures of $# image(s) did not come up — NOT fit to publish" >&2
    exit 1
fi
echo "==> every image booted and reported a converged daemon"
