import { agentsContract } from "@intentic/sandbox-contract/contracts/agents.contract";
import { fleetAttention } from "@intentic/sandbox-contract/models/agent-lanes";
import { implement } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import { visibleTo } from "../auth/fleet-scope.js";
import type { Services } from "../composition.js";

// `GET /agents/attention`: the two counts the desktop app's status bar reads over the loopback port (`ic sandbox
// attention`), by the board's own rules (the contract's models/agent-lanes.ts `fleetAttention`), so the bar and the board
// cannot disagree. Over the same fleet `list` answers its caller, who is the owner (the route's floor), and the same held
// wakes. Beside agents.routes.ts rather than in it: router.ts merges the two into the `agents` group.
export const createAttentionRoutes = (services: Pick<Services, "agents" | "heldWakes">) => {
    const i = implement(agentsContract).$context<OrpcContext>();
    return {
        attention: i.attention.handler(async ({ context }) => {
            // As `list` does: a roster read refreshes the standings it counts.
            await services.agents.refreshStandings();
            const agents = services.agents.list().filter((agent) => visibleTo(context.identity, agent));
            return fleetAttention(agents, await services.heldWakes.list());
        }),
    };
};
