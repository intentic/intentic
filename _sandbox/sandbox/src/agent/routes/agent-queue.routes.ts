import { agentContract } from "@intentic/sandbox-contract/contracts/agent.contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { provenanceOf, refuseUnlessVisible } from "../../auth/fleet-scope.js";
import type { Services } from "../../composition.js";
import { queueView } from "../../conversations/actor/conversation-queue.js";
import { opt } from "../../opt.js";

// `POST /agent/queue/reroute`: a person's waiting words pointed at another pick, letting nothing go
// (conversation-queue.ts, rerouted). Beside agent.routes.ts rather than in it: router.ts merges them into the `agent`
// group.

export const createAgentQueueRoutes = (services: Pick<Services, "agents" | "conversations">) => {
    const i = implement(agentContract).$context<OrpcContext>();
    return {
        // The words otherwise go by themselves on the pick they were sent under, whatever the composer says now. Held ones
        // stay held and booked ones keep their time; a pick that changes nothing for them writes nothing.
        queueReroute: i.queueReroute.handler(async ({ input, context }) => {
            // A guest drives only its own conversations (auth/fleet-scope.ts), as every other queue change does.
            const entry = services.agents.entry(input.conversationId);
            if (entry !== undefined) {
                refuseUnlessVisible(context.identity, provenanceOf(entry));
            }
            if (services.conversations.queued(input.conversationId).items.length === 0) {
                throw new ORPCError("NOT_FOUND", { message: "Nothing waits in that conversation's queue to move: it has gone out, or was taken back." });
            }
            await services.conversations.send(input.conversationId, { kind: "queue-rerouted", routing: input.routing, ...opt("ids", input.ids) }).settled;
            return queueView(services.conversations.queued(input.conversationId));
        }),
    };
};
