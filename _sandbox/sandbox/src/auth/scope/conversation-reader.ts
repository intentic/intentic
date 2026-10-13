import { roleAtLeast } from "@intentic/sandbox-contract";
import type { PersistedAgent } from "../../conversations/registry/agents-store.js";
import type { Caller } from "../auth.js";
import { type Provenance, provenanceOf, visibleTo } from "../fleet-scope.js";

// Whether a caller may read what one conversation wrote, for the routes that hand out a conversation's words by its id
// rather than through the roster (the activity log, the fleet's recall, a loop's prompt, a privacy ledger excerpt, a
// held wake, a share link). The rule is the roster's own (fleet-scope.ts visibleTo); this adds what those routes need
// besides: the owner, a maintainer and the owner's own tools (no identity) read everything, and anyone else reads
// nothing tied to no conversation or to one the registry no longer knows, since there is no fence to check it against.
// (2026-10-13) Each of those routes answered every member alike, so a member fenced to one area read the prompts of
// conversations in every other.

export type ConversationReader = (conversationId: string | undefined) => boolean;

export const readsEverything = (caller: Caller | undefined): boolean => caller === undefined || roleAtLeast(caller.role, "maintainer");

// Whether every conversation is visible to this caller anyway (an unfenced member who is not a guest), so words that
// name no conversation to check (a snapshot's label, a past session's transcript) are theirs to read as well.
export const seesWholeFleet = (caller: Caller | undefined): boolean =>
    readsEverything(caller) || (caller !== undefined && caller.role !== "guest" && caller.areas === undefined);

export const conversationReader = (caller: Caller | undefined, agentOf: (id: string) => Provenance | undefined): ConversationReader => {
    if (readsEverything(caller)) {
        return () => true;
    }
    return (conversationId) => {
        const agent = conversationId === undefined ? undefined : agentOf(conversationId);
        return agent !== undefined && visibleTo(caller, agent);
    };
};

// The registry's answer to whose a conversation is, live and archived alike.
export const registryProvenance =
    (agents: { readonly entry: (id: string) => PersistedAgent | undefined }) =>
    (id: string): Provenance | undefined => {
        const entry = agents.entry(id);
        return entry === undefined ? undefined : provenanceOf(entry);
    };
