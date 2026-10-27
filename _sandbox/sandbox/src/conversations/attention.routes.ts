import { agentsContract } from "@intentic/sandbox-contract/contracts/agents.contract";
import { fleetAttention } from "@intentic/sandbox-contract/models/agent-lanes";
import { implement } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import { theirs, visibleTo } from "../auth/fleet-scope.js";
import type { Services } from "../composition.js";
import { homeConversationOf } from "./home/home-conversation.js";
import { standingsForRead } from "./standings-read.js";

// `GET /agents/attention`: the two counts the desktop app's status bar reads over the loopback port (`ic sandbox
// attention`), by the board's own rules (the contract's models/agent-lanes.ts `fleetAttention`), so the bar and the board
// cannot disagree. Over the same fleet `list` answers its caller, who is the owner (the route's floor), and the same held
// wakes. `GET /agents/attention/mine` is every member's own share of it, which a sandbox's icon in the master view wears:
// only the conversations the caller answers for, their subagents counted through their family's one card, and no held
// wake, which is the owner's to allow. `GET /agents/home` is the caller's home conversation (home/home-conversation.ts).
// Beside agents.routes.ts rather than in it: router.ts merges these with home/home-fresh.routes.ts into the `agents` group.
export const createAttentionRoutes = (services: Pick<Services, "agents" | "heldWakes" | "auth">) => {
    const i = implement(agentsContract).$context<OrpcContext>();
    return {
        attention: i.attention.handler(async ({ context }) => {
            // As `list` does: a roster read refreshes the standings it counts.
            await standingsForRead(services.agents);
            const agents = services.agents.list().filter((agent) => visibleTo(context.identity, agent));
            return fleetAttention(agents, await services.heldWakes.list());
        }),
        attentionMine: i.attentionMine.handler(async ({ context }) => {
            await standingsForRead(services.agents);
            const caller = context.identity;
            // No identity is the loopback owner, who answers for the whole sandbox.
            const agents = services.agents.list().filter((agent) => caller === undefined || (visibleTo(caller, agent) && theirs(caller, agent)));
            return fleetAttention(agents, []);
        }),
        home: i.home.handler(({ context }) => homeConversationOf(services, context)),
    };
};
