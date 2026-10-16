import type { Caller } from "../auth/auth.js";
import { conversationReader, registryProvenance, seesWholeFleet } from "../auth/scope/conversation-reader.js";
import { sessionsContract } from "@intentic/sandbox-contract/contracts/sessions.contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";

export type SessionsRoutesDeps = Pick<Services, "agents" | "sessions" | "workspace">;

// Which past sessions a caller may read. Someone every conversation is visible to reads them all; anyone else (fenced
// to areas, or a guest) reads a session only through the conversation it belongs to, since a session id is a provider's
// and names no fence of its own. A session the registry ties to no conversation is not theirs.
const sessionReader = (services: Pick<Services, "agents">, caller: Caller | undefined): ((sessionId: string) => boolean) => {
    if (seesWholeFleet(caller)) {
        return () => true;
    }
    const reads = conversationReader(caller, registryProvenance(services.agents));
    const owners = new Map(services.agents.ids().flatMap((id) => {
        const sessionId = services.agents.entry(id)?.sessionId;
        return sessionId === undefined ? [] : [[sessionId, id] as const];
    }));
    return (sessionId) => reads(owners.get(sessionId));
};

// Past conversations in this workspace (SDK-native session store, keyed on the working dir). A read that
// throws (no such session) becomes NOT_FOUND, the route's documented behavior, not a swallowed error.
export const createSessionsRoutes = (services: SessionsRoutesDeps) => {
    const i = implement(sessionsContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async ({ input, context }) => {
            const query = input.query?.trim();
            const root = services.workspace.root;
            const reads = sessionReader(services, context.identity);
            const sessions = query ? await services.sessions.search(query, input.caseSensitive === true) : await services.sessions.list(root);
            return { sessions: sessions.filter((session) => reads(session.id)) };
        }),
        get: i.get.handler(async ({ input, context }) => {
            if (!sessionReader(services, context.identity)(input.id)) {
                throw new ORPCError("NOT_FOUND", { message: "session not found" });
            }
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
