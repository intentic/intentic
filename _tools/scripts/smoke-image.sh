#!/usr/bin/env bash
# BOOT THE IMAGE THAT IS ABOUT TO SHIP AND MAKE IT PROVE IT IS ALIVE.
#
#   bash _tools/scripts/smoke-image.sh ghcr.io/intentic/sandbox:sha-abc1234-amd64 [more refs...]
#
# WHY THIS EXISTS. Everything upstream of the image jobs runs in the DEVELOPMENT install: the root node_modules,
# every devDependency present, every workspace package linked. The image runs a tree that
# prepare-image-trees.sh pruned with `pnpm deploy --prod`. Those two graphs are not the same graph, and the
# difference is invisible to `build`, `typecheck` and every vitest suite — all four of which stay green while
# the daemon the image actually starts dies on its first import.
#
# That is not a hypothetical failure mode. On 2026-08-18 a host-side module imported the extension API's root
# barrel for one constant; the barrel re-exports a browser module that imports `vue` as a value, `vue` is a dev
# dependency and an unmet peer, so it is absent from the pruned tree — and the daemon crashed on boot. The
# pipeline was green, `sandbox:latest` was published, and the first thing that noticed was an update on a real
# machine timing out at "the sandbox did not become healthy within 30s".
#
# Nothing per-push booted the artifact. The nightly tiers do (`sandbox.e2e.test.ts`,
# verify-update-survival.sh), but they run against ALREADY PUBLISHED images up to a day later — which makes
# them the report, not the gate. This script is the gate: it runs on the arch that just built the half, before
# any moving tag (`latest`, `stable`) is stitched onto it.
#
# WHAT "ALIVE" MEANS HERE, and why it is more than a 200. /health answers as soon as the HTTP server is
# listening, which is well before the daemon has converged — so a box that opens the port and then fails every
# boot step would sail through a plain liveness probe. The probe below asserts the whole contract the launch
# scripts and ic's postflight read:
#
#   * the container is still RUNNING          — a crash-on-import exits, and exiting is checked every pass so
#                                               the failure is reported in seconds rather than at the timeout
#   * /health returns 200 with ok: true       — the app is assembled and serving
#   * boot.ready is true                      — every step in main.ts's BOOT_STEPS converged
#   * no boot step is in state "failed"       — checked separately, and NOT retried: a failed step is terminal,
#                                               so waiting out the timeout would only delay the same verdict
#   * the starter site is baked AND seeded     — the first screen of a new sandbox, which fails silently on both
#                                               sides (see the probe); this container has a new box's exact
#                                               shape, so it is the cheapest place in the pipeline to read it
#
# The probe runs INSIDE the container via the image's own node — no curl, no jq, no assumption about what the
# runner has. Node is the daemon's runtime, so it is the one interpreter the image is guaranteed to carry.
#
# Hermetic by construction: no CONNECT_TOKEN and no SANDBOX_PUBLIC_URL, so main.ts's `requireAuthWhenReachable`
# reads this as a loopback daemon and asks for no Google client id, exactly as the e2e harness's loopback mode
# does. No volumes, no ports published, unprivileged — the baked Docker Engine stays dormant. A Docker daemon
# is the whole requirement.
set -euo pipefail

[ "$#" -gt 0 ] || { echo "usage: smoke-image.sh <image-ref> [<image-ref>...]" >&2; exit 2; }

# Generous because it covers a COLD boot on a runner that may also be pulling: the daemon's own steps are
# seconds, but the pull that precedes `docker run` is not, and testcontainers gives the same boot 180s.
TIMEOUT="${SMOKE_TIMEOUT:-240}"

# Drop each image from the local store once it has been smoked. OFF by default, because on the self-hosted
# fleet the pulled layers are a warm parent for the next pipeline's build and throwing them away is pure loss.
# ON for the GitHub-hosted arm runners: buildx pushes from its own cache without populating the docker store,
# so `docker run` pulls a second ~5 GB copy of an image that runner has just built — and a hosted runner's disk
# is the one place that matters.
RMI="${SMOKE_RMI:-0}"

# Every container this run started, so a cancelled job (the one exit path the per-verdict cleanup below cannot
# reach) does not leave a 5 GB box running on a shared runner. Names never contain spaces, so the split is safe.
STARTED=""
trap 'for leftover in $STARTED; do docker rm -f "$leftover" >/dev/null 2>&1 || true; done' EXIT

# The one probe, as bytes rather than an escaped one-liner — a quoted heredoc so nothing here is expanded by
# the shell on its way into the container.
PROBE="$(
    cat <<'JS'
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const fail = (code, why) => { console.error(why); process.exit(code); };
(async () => {
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
    /* THE STARTER SITE, THE ONE THING A NEW USER SEES, and until this ran neither half of it was guarded.
     *
     * It is half image (the Dockerfile bakes the monorepo at /opt/starter) and half daemon (the first boot
     * copies it into the workspace and starts its dev server, src/scaffold/starter-site.ts), and the two halves
     * fail silently in opposite directions: a bake that stops landing leaves a daemon with nothing to copy, and
     * a daemon that decides "this workspace is not fresh" leaves a perfectly good bake untouched. Both open an
     * empty sandbox and neither fails anything. The desktop installs of 2026-08-24 shipped the second one for a
     * day, with a green pipeline the whole time.
     *
     * This container is exactly the shape that first boot has: no volumes, so /work is empty and the daemon
     * owns it. Terminal (exit 2) rather than retried, the seed is awaited inside the boot chain, so once
     * boot.ready is true the answer will not change by looking again.
     *
     * Names come from the image's own contract module, never from a copy in this script: the browser, the
     * daemon and the Dockerfile all read them from there, and a fourth spelling here would be the one that
     * rots. */
    let starter;
    try {
        starter = require("/opt/sandbox/node_modules/@intentic/sandbox-contract/dist/starter.js");
    } catch (error) {
        // Terminal and named: an unreadable contract module is a moved path, not a slow boot, and retrying it
        // until the timeout would report "still not healthy" over a daemon that is perfectly alive.
        fail(2, `cannot read the starter contract from the image: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }
    const { STARTER_APP, STARTER_REPO } = starter;
    if (!existsSync(join("/opt/starter/_apps", STARTER_APP))) {
        fail(2, `the image bakes no starter site: /opt/starter/_apps/${STARTER_APP} is absent`);
        return;
    }
    const seeded = join(process.env.WORKSPACE_ROOT ?? "/work", STARTER_REPO, "_apps", STARTER_APP);
    if (!existsSync(seeded)) {
        fail(2, `the daemon converged but seeded no starter site: ${seeded} is absent (a fresh workspace must open with one)`);
        return;
    }
    console.log(`ok · profile=${health.profile} · ${steps.length} boot step(s) done · starter site seeded`);
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
    docker rm -f "$name" >/dev/null 2>&1 || true
    STARTED="$STARTED $name"
    docker run -d --name "$name" "$image" >/dev/null

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
