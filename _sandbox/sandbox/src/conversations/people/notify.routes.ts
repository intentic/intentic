import type { agentsContract } from "@intentic/sandbox-contract/contracts/agents.contract";
import { type Implementer, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { framedSummary, provenanceOf, refuseUnlessVisible } from "../../auth/fleet-scope.js";
import type { Services } from "../../composition.js";

type AgentsImplementer = Implementer<typeof agentsContract, OrpcContext, OrpcContext>;

// How much of a conversation reaches the caller (sandbox-contract schemas/agent-people.ts): their own answer,
// never anyone else's. Legal in every state, mid-turn and archived alike, like a reaction: it touches none of the work.
// Refused for a conversation the caller may not read, whose news would never reach them anyway (push/push.ts).
export const notifyRoutes = (i: AgentsImplementer, services: Pick<Services, "agents">) => ({
    notify: i.notify.handler(async ({ input, context }) => {
        const entry = services.agents.entry(input.id);
        if (entry === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
        }
        refuseUnlessVisible(context.identity, provenanceOf(entry));
        if (context.identity === undefined) {
            throw new ORPCError("UNAUTHORIZED", { message: "no verified identity to choose for" });
        }
        const summary = await services.agents.setNotify(input.id, context.identity.email, input.level, Date.now());
        const shown = summary === undefined ? undefined : framedSummary(context.identity, summary);
        if (shown === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
        }
        return shown;
    }),
});
