import { sessionsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

export type SessionsRoutesDeps = Pick<Services, "sessions" | "workspace">;

// Past conversations in this workspace (SDK-native session store, keyed on the working dir). A read that
// throws (no such session) becomes NOT_FOUND — the route's documented behavior, not a swallowed error.
export const createSessionsRoutes = (services: SessionsRoutesDeps) => {
    const i = implement(sessionsContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async ({ input }) => {
            const query = input.query?.trim();
            const root = services.workspace.root;
            return { sessions: query ? await services.sessions.search(root, query) : await services.sessions.list(root) };
        }),
        get: i.get.handler(async ({ input }) => {
            // The workspace root reaches an ISOLATED conversation's transcript too: its turns ran in a linked
            // worktree of this repo, and the SDK's store spans a repo's worktrees rather than one checkout.
            try {
                return { messages: await services.sessions.read(services.workspace.root, input.id) };
            } catch {
                throw new ORPCError("NOT_FOUND", { message: "session not found" });
            }
        }),
    };
};
