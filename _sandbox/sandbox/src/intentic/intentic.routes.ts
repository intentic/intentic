import { errorMessage } from "@intentic/base/errors";
import { intenticContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { applyEventsPath, isTerminalExit, tailIntenticEvents } from "./apply-events.js";
import { runCheckCommand } from "./check-run.js";
import { INFRA_APPLY_KEY, startInfraApplyJob } from "./infra-apply.js";

// Runs the CLI over the workspace root, streaming its lines. resolve/plan run visibly in the job-infra-check tmux
// session; other calls use the invisible streamed child. A non-zero exit yields a terminal error line first, or oRPC
// masks it as INTERNAL_SERVER_ERROR.
export const createIntenticRoutes = (services: Services) => {
    const i = implement(intenticContract).$context<OrpcContext>();
    return {
        run: i.run.handler(async function* ({ input, signal }) {
            try {
                // The abort signal reaches the CLI child either way: a closed tab kills the run instead of leaking it.
                if (input.args[0] === "deploy" && (input.args[1] === "resolve" || input.args[1] === "plan")) {
                    yield* runCheckCommand(services, input.args, signal);
                } else {
                    yield* services.intentic({ args: input.args, cwd: services.workspace.root }, signal);
                }
            } catch (error) {
                const message = errorMessage(error);
                yield { kind: "error", message };
                throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
            }
        }),
        // One-shot infra reconcile in the panel-infra-apply tmux session (shared with the service capability), so it
        // survives navigation and stays attachable via the terminal panel. Already running is idempotent-OK.
        apply: i.apply.handler(async () => {
            await startInfraApplyJob(services);
            return { ok: true } as const;
        }),
        // Tails the durable apply events file as an SSE stream (same wire shape as `run`); replays from the start,
        // follows live, and closes on the terminal exit line or when the job is gone. Empty stream if no apply has run.
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
