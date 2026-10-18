import { agentContract } from "@intentic/sandbox-contract/contracts/agent.contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { provenanceOf, refuseUnlessVisible } from "../../auth/fleet-scope.js";
import type { Services } from "../../composition.js";
import { queueView } from "../../conversations/actor/conversation-queue.js";
import type { ContinueBooked } from "../../seams/turn-starter.js";
import { speakerOf, spokenBy } from "../../seams/turn-speaker.js";

// `POST /agent/queue/continue`: a Continue booked for later, a continuation in the queue rather than words
// (agent/run/turn/continuation.ts). Beside agent.routes.ts rather than in it: router.ts merges the two into the `agent`
// group.

// Why booking did not take, as the route answers it; undefined when it booked, or carried on now.
const refusalOf = (outcome: ContinueBooked): ORPCError<string, unknown> | undefined => {
    if (outcome === "booked" || outcome === "started") {
        return undefined;
    }
    if (outcome === "unknown") {
        return new ORPCError("NOT_FOUND", { message: "No such conversation to continue." });
    }
    if (outcome === "busy") {
        return new ORPCError("CONFLICT", { message: "a turn is already running in that conversation" });
    }
    return new ORPCError("BAD_REQUEST", { message: outcome.invalid });
};

export const createAgentContinueRoutes = (services: Pick<Services, "agents" | "conversations" | "turns">) => {
    const i = implement(agentContract).$context<OrpcContext>();
    return {
        // Answered with the queue it left, which holds no continuation when its time had already come and it carried on now.
        queueContinue: i.queueContinue.handler(async ({ input, context }) => {
            // A guest drives only its own conversations (auth/fleet-scope.ts), as every other queue change does.
            const entry = services.agents.entry(input.conversationId);
            if (entry !== undefined) {
                refuseUnlessVisible(context.identity, provenanceOf(entry));
            }
            const refusal = refusalOf(await services.turns.continueAt({ ...input, ...spokenBy(speakerOf(context.identity, context.principal)) }));
            if (refusal !== undefined) {
                throw refusal;
            }
            return queueView(services.conversations.queued(input.conversationId));
        }),
    };
};
