import { loopCanConverge, loopsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { streamAgent } from "../agent/routes/agent.routes.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { loopRunning, runLoop, stopLoop } from "./loop-runner.js";

// Thin by design: the pump owns everything after `start` acks, since a loop outlives the request by minutes or hours.
export const createLoopsRoutes = (services: Services) => {
    const i = implement(loopsContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async () => ({ loops: await services.loops.list() })),
        start: i.start.handler(async ({ input }) => {
            // Refused, not queued: two pumps on one conversation would race the same worktree and turn mutex.
            if (loopRunning(input.conversationId)) {
                throw new ORPCError("CONFLICT", { message: "This agent is already looping, stop that loop before starting another." });
            }
            // No output and no check: a loop can only run out of iterations, refused here instead of failing slowly.
            if (!loopCanConverge(input)) {
                throw new ORPCError("BAD_REQUEST", {
                    message: "This loop has no output and no check, so nothing could ever tell it it is finished.",
                });
            }
            const record = await services.loops.start(input, Date.now());
            // Detached like any turn-starting route: the first iteration can take minutes; watched from the fleet card.
            void runLoop(services, record, streamAgent);
            return record;
        }),
        stop: i.stop.handler(async ({ input }) => {
            if (!stopLoop(input.conversationId)) {
                // Not-running usually means it already ended, which the row shows; an empty `ok` would say nothing.
                throw new ORPCError("NOT_FOUND", { message: "No loop is running on this agent." });
            }
            return { ok: true as const };
        }),

        designs: i.designs.handler(async () => ({ designs: await services.loopDesigns.list() })),
        saveDesign: i.saveDesign.handler(async ({ input }) => {
            // Same refusal as `start`, made at save time: a saved loop that can't converge is a trap left for everyone
            // who picks it up, not just one run.
            if (!loopCanConverge(input.design)) {
                throw new ORPCError("BAD_REQUEST", {
                    message: "This loop has no output and no check, so nothing could ever tell it it is finished.",
                });
            }
            const outcome = await services.loopDesigns.save(input.design, input.create);
            if (outcome === "conflict") {
                throw new ORPCError("CONFLICT", { message: `A saved loop called "${input.design.name}" already exists.` });
            }
            if (outcome === "missing") {
                throw new ORPCError("NOT_FOUND", { message: "That saved loop no longer exists, it may have been deleted in another tab." });
            }
            return input.design;
        }),
        removeDesign: i.removeDesign.handler(async ({ input }) => {
            if (!(await services.loopDesigns.remove(input.id))) {
                throw new ORPCError("NOT_FOUND", { message: "No saved loop with that id." });
            }
            return { ok: true as const };
        }),
    };
};
