import type { agentsContract } from "@intentic/sandbox-contract/contracts/agents.contract";
import { type Implementer, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import type { agentLookups } from "./agent-lookups.js";

type AgentsImplementer = Implementer<typeof agentsContract, OrpcContext, OrpcContext>;
type Lookups = Pick<ReturnType<typeof agentLookups>, "entryFor" | "framed">;

// The auto-approve mark (sandbox-contract schemas/auto-approve.ts), put on or taken off several conversations at once.
// Every id is looked up before any is written, so one the caller may not see leaves them all as they were. Kept with the
// conversation's other yeses (roles/conversation-grants.ts), never in its registry entry; the cards it wears are read
// again before the press is answered, and the cards already waiting where a mark now reaches are answered with it.
export const autoApproveRoutes = (i: AgentsImplementer, services: Pick<Services, "agents" | "cards" | "conversationGrants">, { entryFor, framed }: Lookups) => ({
    autoApprove: i.autoApprove.handler(async ({ input, context }) => {
        const entries = [...new Set(input.ids)].map((id) => entryFor(id, context));
        const by = context.identity?.email;
        for (const entry of entries) {
            await (input.on ? services.conversationGrants.markAutoApprove(entry.id, by) : services.conversationGrants.unmarkAutoApprove(entry.id));
        }
        await services.agents.reloadMarks();
        if (input.on) {
            await services.cards.restand(by);
        }
        return {
            agents: entries.map((entry) => {
                const summary = services.agents.get(entry.id);
                if (summary === undefined) {
                    throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
                }
                return framed(context, summary);
            }),
        };
    }),
});
