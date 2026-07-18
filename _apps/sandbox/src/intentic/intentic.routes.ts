import { intenticContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { applyEventsPath, isTerminalExit, tailIntenticEvents } from "./apply-events.js";
import { runCheckCommand } from "./check-run.js";
import { INFRA_APPLY_KEY, startInfraApplyJob } from "./infra-apply.js";

// Run the in-sandbox intentic CLI over the workspace root (where intent/desired-state/app live), streaming
// structured lines as they arrive. resolve/plan (the check flow — real shell actions) run VISIBLY in the
// job-infra-check tmux session with their events tailed from a per-run file; anything else (`deployments`, a
// polled read) stays on the invisible streamed child — never run polled reads in terminals. A non-zero exit
// throws with the real output; surface that as a terminal `error` line the UI renders, THEN fail the RPC —
// otherwise oRPC masks it behind INTERNAL_SERVER_ERROR.
export const createIntenticRoutes = (services: Services) => {
    const i = implement(intenticContract).$context<OrpcContext>();
    return {
        run: i.run.handler(async function* ({ input, signal }) {
            try {
                // The abort signal reaches the CLI child either way: a closed tab kills the run instead of leaking it.
                if (input.args[0] === "resolve" || input.args[0] === "plan") {
                    yield* runCheckCommand(services, input.args, signal);
                } else {
                    yield* services.intentic({ args: input.args, cwd: services.workspace.root }, signal);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                yield { kind: "error", message };
                throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
            }
        }),
        // One-shot infra reconcile in tmux session panel-infra-apply (startInfraApplyJob — shared with the
        // service capability): survives refresh/navigation, attachable via the global terminal panel, output
        // readable in scrollback above a live prompt after it finishes. Already-running is idempotent-OK.
        apply: i.apply.handler(async () => {
            await startInfraApplyJob(services);
            return { ok: true } as const;
        }),
        // Tail the durable apply events file as an SSE event-iterator (same wire shape as `run`, so the web reuses
        // readIntenticLines unchanged): replays from the run's start then follows live, closing on the terminal
        // {kind:"exit"} line or when the tmux job is gone. Idle when no apply has run (empty stream).
        applyEvents: i.applyEvents.handler(async function* ({ signal }) {
            yield* tailIntenticEvents(
                applyEventsPath(services.config.historyRoot),
                isTerminalExit,
                () => services.processes.running(INFRA_APPLY_KEY),
                signal,
            );
        }),
    };
};
