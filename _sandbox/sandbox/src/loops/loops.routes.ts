import { loopCanConverge, loopsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { streamAgent } from "../agent/agent.routes.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { loopRunning, runLoop, stopLoop } from "./loop-runner.js";

/* The loop routes. Thin by design — the pump owns everything that happens after `start` acks, because a loop
 * outlives the request that began it by minutes or hours and there is nothing useful for a handler to await.
 */
export const createLoopsRoutes = (services: Services) => {
    const i = implement(loopsContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async () => ({ loops: await services.loops.list() })),
        start: i.start.handler(async ({ input }) => {
            // Refused rather than queued: two pumps on one conversation would race the same worktree and the
            // same turn mutex, and the loser would spend a whole turn finding that out.
            if (loopRunning(input.conversationId)) {
                throw new ORPCError("CONFLICT", { message: "This agent is already looping — stop that loop before starting another." });
            }
            // A loop with nothing to produce and nothing to check cannot succeed; it can only run out of
            // iterations. Refused here rather than left to fail slowly, because failing slowly costs money.
            if (!loopCanConverge(input)) {
                throw new ORPCError("BAD_REQUEST", {
                    message: "This loop has no output and no check, so nothing could ever tell it it is finished.",
                });
            }
            const record = await services.loops.start(input, Date.now());
            // Detached, like every other route that starts a turn: the first iteration alone can take minutes,
            // and the fleet card is where the loop is watched from.
            void runLoop(services, record, streamAgent);
            return record;
        }),
        stop: i.stop.handler(async ({ input }) => {
            if (!stopLoop(input.conversationId)) {
                // A loop that is not running cannot be stopped, and saying so beats an `ok` that means nothing:
                // the usual cause is that it already ended, which the row now shows.
                throw new ORPCError("NOT_FOUND", { message: "No loop is running on this agent." });
            }
            return { ok: true as const };
        }),
    };
};
