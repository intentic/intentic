import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { IntenticLine } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { INFRA_CHECK_SESSION } from "../terminal/terminal-session.js";
import { resetEventsFile, tailIntenticEvents } from "./apply-events.js";

// The check flow's substrate: run one `intentic deploy resolve` / `intentic deploy plan` VISIBLY in the job-infra-check tmux
// session (human output in the pane the terminals panel attaches) while streaming the same structured events
// the old invisible runner produced — the CLI mirrors them to a per-run events file (INTENTIC_EVENTS_FILE)
// this generator tails. Per-run files (not the apply job's fixed durable path) because two browser tabs can
// check concurrently; each file is deleted after its run and the whole dir is swept at boot.
export const checkEventsDir = (historyRoot: string): string => join(historyRoot, "check-events");

// Whole-run ceiling, parity with the old streamed runner: every network operation under resolve/plan is
// individually bounded, so a run still alive after this is wedged, not working.
const RUN_WATCHDOG_MS = 10 * 60_000;

export async function* runCheckCommand(services: Services, args: readonly string[], signal: AbortSignal | undefined): AsyncGenerator<IntenticLine> {
    const path = join(checkEventsDir(services.config.historyRoot), `${randomUUID()}.ndjson`);
    await resetEventsFile(path);
    if (services.terminalRun.visible) {
        yield { kind: "terminal", session: INFRA_CHECK_SESSION };
    }
    // Composed abort: the caller's signal (closed tab — a dropped check must not leak a live `intentic deploy plan`
    // holding SSH connections) plus this generator's own teardown (a consumer that stops iterating without
    // aborting). Either SIGTERMs the wrapper, whose trap kills the tmux window.
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    let settled = false;
    const done = services.terminalRun
        .tryRun(INFRA_CHECK_SESSION, ["intentic", ...args].map(shellQuote).join(" "), {
            cwd: services.workspace.root,
            window: args[1] ?? args[0] ?? "run",
            // Rides -e onto the tmux window (pane env ≠ daemon env) AND the wrapper's env for the fallback.
            env: { INTENTIC_EVENTS_FILE: path },
            signal: controller.signal,
            timeoutMs: RUN_WATCHDOG_MS,
        })
        .finally(() => {
            settled = true;
        });
    try {
        // Replay + follow until the run's own {kind:"exit"} (single-command file); !settled covers a run killed
        // without writing one (SIGKILL) — the wrapper resolving flips it and the tail closes on its next poll.
        yield* tailIntenticEvents(
            path,
            (line) => line.kind === "exit",
            () => !settled,
            controller.signal,
        );
        const { code, output } = await done;
        if (code !== 0) {
            const tail = output.trim().split("\n").slice(-15).join("\n");
            throw new Error(`intentic ${args.join(" ")} exited ${code}${tail === "" ? "" : `: ${tail}`}`);
        }
    } finally {
        signal?.removeEventListener("abort", onAbort);
        if (!settled) {
            controller.abort(new Error("the stream consumer went away"));
        }
        // Reap the wrapper before deleting its events file; the abort path rejects — that verdict already
        // propagated (or the consumer is gone), so it is swallowed here.
        await done.catch(() => undefined);
        await rm(path, { force: true });
    }
}
