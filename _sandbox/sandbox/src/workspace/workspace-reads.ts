import type { Fence } from "@intentic/sandbox-contract/policy/fence-paths";
import type { OrpcContext } from "../app-env.js";
import { callerFence } from "../areas/area-scope.js";
import { provenanceOf, refuseUnlessVisible } from "../auth/fleet-scope.js";
import type { Services } from "../composition.js";
import { refuseFenced } from "./layout/workspace-fence.js";
import { scopedTarget } from "./layout/workspace-scope.js";

// The questions every workspace read asks of its caller before a path reaches the resolver, shared by the workspace's
// routes (workspace.routes.ts) and the tickets that stand in for a bearer (workspace-tickets.routes.ts), so the two
// cannot disagree on who may look where.
export const workspaceReads = (services: Pick<Services, "areas" | "agents" | "workspaceScope">) => {
    // The caller's own fence, read per request so an area edit lands on the very next one rather than at next sign-in.
    const fenceFor = async (context: OrpcContext): Promise<Fence> => callerFence(await services.areas.list(), context.identity);
    // A conversation's checkout is its own. A caller who may not see the conversation may not read out of it either,
    // or every fence would have a second door marked with somebody else's id.
    const refuseUnseenAgent = (context: OrpcContext, agent: string | undefined): void => {
        if (agent === undefined) {
            return;
        }
        const entry = services.agents.entry(agent);
        // An unknown id stays NOT_FOUND from the scope resolver; saying FORBIDDEN here would answer whether it exists.
        if (entry !== undefined) {
            refuseUnlessVisible(context.identity, provenanceOf(entry));
        }
    };
    // Every scoped read asks both questions before a path reaches the resolver: whose copy, and whether this caller
    // may look there at all.
    const scopedRead = async (context: OrpcContext, agent: string | undefined, relPath: string) => {
        refuseUnseenAgent(context, agent);
        refuseFenced(await fenceFor(context), relPath);
        return scopedTarget(services.workspaceScope, agent, relPath);
    };
    return { fenceFor, refuseUnseenAgent, scopedRead };
};
