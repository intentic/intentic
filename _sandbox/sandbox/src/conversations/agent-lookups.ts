import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import { framedSummary, provenanceOf, refuseUnlessListed, refuseUnlessVisible } from "../auth/fleet-scope.js";
import type { Services } from "../composition.js";
import { type IsolatedAgent, isIsolated, type PersistedAgent } from "./registry/agents-store.js";

/* How every route on the board addresses one conversation (agents.routes.ts): unknown is NOT_FOUND, and one the caller
 * may not reach is FORBIDDEN (auth/fleet-scope.ts). A route's role floor says what a caller may do, never to whose
 * conversation, so no route reads or acts on an id without one of these.
 *
 * Two reaches, since a private conversation's words are its readers' and its work is everyone's who is shown its card
 * (schemas/seal.ts): `entryFor` for a route that reads or writes what it says (its transcript, a rename, a reaction, a
 * turn), `workEntryFor` for one that acts on its work alone (its diff, its land, its archive). `drive`: a write a
 * home-only member makes on their own home alone (home-conversation.ts refuseUnlessHome). */

// `refuseHome` is home-conversation.ts refuseUnlessHome, handed in by the routes so this module stays below home/.
type RefuseHome = (services: Services, context: OrpcContext, id: string) => void;

export const agentLookups = (services: Services, refuseUnlessHome: RefuseHome) => {
    const known = (id: string): PersistedAgent => {
        const entry = services.agents.entry(id);
        if (entry === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "unknown agent" });
        }
        return entry;
    };
    const entryFor = (id: string, context: OrpcContext, drive?: "drive"): PersistedAgent => {
        const entry = known(id);
        refuseUnlessVisible(context.identity, provenanceOf(entry));
        if (drive !== undefined) {
            refuseUnlessHome(services, context, id);
        }
        return entry;
    };
    const workEntryFor = (id: string, context: OrpcContext, drive?: "drive"): PersistedAgent => {
        const entry = known(id);
        refuseUnlessListed(context.identity, provenanceOf(entry));
        if (drive !== undefined) {
            refuseUnlessHome(services, context, id);
        }
        return entry;
    };
    // Branch-only half of the registry, for routes that act on a worktree; a workspace conversation can't answer these,
    // so it's BAD_REQUEST, not NOT_FOUND. Work, so a sealed card's diff and land answer whoever is shown the card.
    const isolatedEntryOf = (id: string, context: OrpcContext, drive?: "drive"): IsolatedAgent => {
        const entry = workEntryFor(id, context, drive);
        if (!isIsolated(entry)) {
            throw new ORPCError("BAD_REQUEST", { message: "this conversation works in the shared workspace and has no isolated branch" });
        }
        return entry;
    };
    // A card as this caller is shown it, for a route answering with one: a sealed card for anyone who may not read it.
    const framed = (context: OrpcContext, summary: AgentSummary): AgentSummary => {
        const shown = framedSummary(context.identity, summary);
        if (shown === undefined) {
            throw new ORPCError("FORBIDDEN", { message: "not one of your conversations" });
        }
        return shown;
    };
    return { entryFor, workEntryFor, isolatedEntryOf, framed };
};
