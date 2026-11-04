import { posix } from "node:path";
import { workspaceContract } from "@intentic/sandbox-contract/contracts/workspace.contract";
import { implement } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { refuseFenced } from "./layout/workspace-fence.js";
import { containedIn, workspaceRootFor } from "./layout/workspace-scope.js";
import { checkoutFollow, FOLLOW_LEASE_MS } from "./watch/checkout-follow.js";
import { workspaceReads } from "./workspace-reads.js";

// A reader keeping a conversation's own copy of the files it has open watched (watch/checkout-follow.ts). Beside
// workspace.routes.ts rather than in it, as the media and ticket routes are: router.ts merges them into the `workspace`
// group.
export const createWorkspaceFollowRoutes = (services: Pick<Services, "areas" | "agents" | "workspaceScope" | "logger">) => {
    const i = implement(workspaceContract).$context<OrpcContext>();
    const { fenceFor, refuseUnseenAgent } = workspaceReads(services);
    return {
        // The same two questions every scoped read asks: whether this caller may see the conversation, and whether its
        // fence reaches each path. A path refused or escaping is left out rather than failing the rest, as a folder's
        // pictures are measured; the lease is answered whatever was watched, so a reader renews on one clock.
        followCheckout: i.followCheckout.handler(async ({ input, context }) => {
            refuseUnseenAgent(context, input.agent);
            // Unknown and archived conversations are refused here, the way a read of their copy is.
            const root = await workspaceRootFor(services.workspaceScope, { agent: input.agent });
            // A conversation on the shared tree has no copy of its own, and the shared watcher already says what it writes.
            if (root === services.workspaceScope.main) {
                return { leaseMs: FOLLOW_LEASE_MS };
            }
            const fence = await fenceFor(context);
            const dirs: string[] = [];
            for (const path of input.paths) {
                try {
                    refuseFenced(fence, path);
                    await containedIn(root, path);
                } catch {
                    // allow(silent-catch): a refused or escaping path is one the watch leaves out, as the contract says
                    continue;
                }
                const dir = posix.dirname(posix.normalize(path));
                dirs.push(dir === "." ? "" : dir);
            }
            return { leaseMs: checkoutFollow(services.logger).follow(input.agent, root, dirs) };
        }),
    };
};
