import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { IntenticLine } from "@intentic/sandbox-contract";
import { whenAborted } from "../abort.js";
import type { Services } from "../composition.js";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { INFRA_CHECK_SESSION } from "../terminal/terminal-session.js";
import { resetEventsFile, tailIntenticEvents } from "./apply-events.js";

// Runs `intentic deploy resolve/plan` visibly in the job-infra-check tmux session while streaming its structured events
// to a per-run file this generator tails. Per-run, not a fixed path, since tabs can check concurrently; each file is
// deleted after its run, the dir swept at boot.
export const checkEventsDir = (historyRoot: string): string => join(historyRoot, "check-events");

// Whole-run ceiling: ops under resolve/plan are already bounded, so outliving this means wedged, not working.
const RUN_WATCHDOG_MS = 10 * 60_000;

export async function* runCheckCommand(services: Services, args: readonly string[], signal: AbortSignal | undefined): AsyncGenerator<IntenticLine> {
    const path = join(checkEventsDir(services.config.historyRoot), `${randomUUID()}.ndjson`);
    await resetEventsFile(path);
    if (services.terminalRun.visible) {
        yield { kind: "terminal", session: INFRA_CHECK_SESSION };
    }
    // Composed abort: caller's signal or this generator's teardown; either SIGTERMs the wrapper, killing its window.
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    const unwatchAbort = whenAborted(signal, onAbort);
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
        // Replays and follows until the run's own exit line; !settled catches a SIGKILL, set once the wrapper resolves.
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
        unwatchAbort();
        if (!settled) {
            controller.abort(new Error("the stream consumer went away"));
        }
        // Reaps the wrapper before deleting its events file; an abort's rejection already propagated, swallowed here.
        await done.catch(() => undefined);
        await rm(path, { force: true });
    }
}
