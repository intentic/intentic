import { agentsContract } from "@intentic/sandbox-contract/contracts/agents.contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { homeIdOf } from "./home-conversation.js";

// THE TWO WAYS A PERSON CLEANS UP THEIR HOME CONVERSATION (home-rollover.ts says why a home starts fresh at all).
//   Start fresh    its next message opens a fresh session: a summary, the latest messages, its subagents. The chat
//                  keeps every row.
//   Clear history  every row goes, and the saved points to go back to with them; its next message opens a fresh
//                  session that knows only the work it has in hand. Nothing it landed or committed moves, and neither
//                  do its subagents.
// Both on the caller's own home only, its id derived from the verified caller as `GET /agents/home` derives it, and
// both under the rewind lease, which a live turn or a rewind holds: a record cannot be cut under a turn writing to it.

export type HomeFreshDeps = Pick<Services, "auth" | "agents" | "conversations" | "transcripts" | "turnCheckpoints">;

const BUSY = "Your home conversation is working right now: wait for it to finish, or stop it first.";

/** Marks the caller's home to start fresh on its next message, and lets its old session go. */
export const startFreshHome = async (deps: HomeFreshDeps, context: Pick<OrpcContext, "identity">): Promise<{ readonly ok: true }> => {
    const id = homeIdOf(deps, context);
    // A home that never ran opens fresh anyway.
    if (deps.agents.entry(id) === undefined) {
        return { ok: true };
    }
    const done = await deps.conversations.withRewindLease(id, async () => {
        await deps.agents.setFreshPending(id, "asked");
        await deps.conversations.send(id, { kind: "session-cleared" }).settled;
        return true;
    });
    if (done === undefined) {
        throw new ORPCError("CONFLICT", { message: BUSY });
    }
    return { ok: true };
};

/** Deletes the caller's home's record and saved points, and starts it fresh; answers how many rows went. */
export const clearHomeHistory = async (deps: HomeFreshDeps, context: Pick<OrpcContext, "identity">): Promise<{ readonly dropped: number }> => {
    const id = homeIdOf(deps, context);
    if (deps.agents.entry(id) === undefined) {
        return { dropped: 0 };
    }
    const dropped = await deps.conversations.withRewindLease(id, async () => {
        // The record re-states the search index from what is left (sessions-slice.ts truncate), so nothing cleared is
        // still found by what it said.
        const gone = await deps.transcripts.truncate({ id }, 0);
        await deps.turnCheckpoints.truncate(id, 0);
        await deps.agents.setFreshPending(id, "cleared");
        await deps.conversations.send(id, { kind: "session-cleared" }).settled;
        return gone;
    });
    if (dropped === undefined) {
        throw new ORPCError("CONFLICT", { message: BUSY });
    }
    return { dropped };
};

// Beside attention.routes.ts's `home`; router.ts merges them into the `agents` group.
export const createHomeFreshRoutes = (deps: HomeFreshDeps) => {
    const i = implement(agentsContract).$context<OrpcContext>();
    return {
        startFreshHome: i.startFreshHome.handler(({ context }) => startFreshHome(deps, context)),
        clearHomeHistory: i.clearHomeHistory.handler(({ context }) => clearHomeHistory(deps, context)),
    };
};
