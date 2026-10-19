import { workspaceContract } from "@intentic/sandbox-contract/contracts/workspace.contract";
import { implement } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { measurable, measure } from "./files/media/workspace-dimensions.js";
import { refuseFenced } from "./layout/workspace-fence.js";
import { scopedTarget } from "./layout/workspace-scope.js";
import { workspaceReads } from "./workspace-reads.js";

// What the workspace's pictures and videos look like before their bytes are fetched: the box each is shown in, for a
// gallery to lay its rows out from. Beside workspace.routes.ts rather than in it, as the tickets are: router.ts merges
// them into the `workspace` group.
export const createWorkspaceMediaRoutes = (services: Services) => {
    const i = implement(workspaceContract).$context<OrpcContext>();
    const { fenceFor, refuseUnseenAgent } = workspaceReads(services);
    return {
        // The fence is read once for the whole folder rather than per path. A path the caller may not see, or that does
        // not resolve, is left out like a file with no picture in it: one refusal must not cost the rest their answers.
        dimensions: i.dimensions.handler(async ({ input, context }) => {
            refuseUnseenAgent(context, input.agent);
            const fence = await fenceFor(context);
            const asked = input.paths.filter(measurable);
            const resolved = await Promise.all(
                asked.map(async (path) => {
                    try {
                        refuseFenced(fence, path);
                        return (await scopedTarget(services.workspaceScope, input.agent, path)).target;
                    } catch {
                        // allow(silent-catch): a refused or escaping path is one the answer leaves out, as the contract says
                        return undefined;
                    }
                }),
            );
            const reachable = asked.flatMap((path, at) => (resolved[at] === undefined ? [] : [{ path, target: resolved[at] }]));
            const measured = await measure(reachable.map(({ target }) => target));
            return { items: reachable.flatMap(({ path }, at) => (measured[at] === undefined ? [] : [{ path, ...measured[at] }])) };
        }),
    };
};
