import type { AutoApproveMark } from "@intentic/sandbox-contract/schemas/auto-approve";
import type { ConversationGrant } from "@intentic/sandbox-contract/schemas/needs";
import { supervisorOf } from "../auth/principal.js";

// WHAT ANSWERS A PERMISSION CARD WITHOUT A PERSON (conversations/actor/parked-cards.ts `StandingYes`), read from the
// conversation grants (conversation-grants.ts). "Allow everything in this conversation" answers the cards of the conversation it was
// given in, and never a hard rule's. The auto-approve mark (schemas/auto-approve.ts) answers those too, and it reaches
// down: a conversation started by a marked one, or by one started by it, follows it, read as each card is raised, so a
// parent marked for the night carries the subagents it starts with nothing copied into them. Followed through who
// started whom (auth/principal.ts `supervisorOf`), as proceeding without asking is (agent/run/decide/proceed.ts).

// Further up than any nesting the settings allow (subagentDepth), so a loop in the records cannot hold a card.
const MAX_HOPS = 16;

/** Where the mark reaches a conversation from: its own, one up the conversations that started it, or nowhere. */
export const autoApproveOf = (marked: (id: string) => boolean, parentOf: (id: string) => string | undefined, conversationId: string): AutoApproveMark => {
    if (marked(conversationId)) {
        return "own";
    }
    let current = parentOf(conversationId);
    for (let hop = 0; current !== undefined && hop < MAX_HOPS; hop += 1) {
        if (marked(current)) {
            return "inherited";
        }
        current = parentOf(current);
    }
    return undefined;
};

/** Whether what stands answers a permission card raised in this conversation; a hard rule's card only the mark answers. */
export const standingAnswers = (
    grants: Readonly<Record<string, ConversationGrant>>,
    parentOf: (id: string) => string | undefined,
    conversationId: string,
    hardRule: boolean,
): boolean => {
    if (!hardRule && grants[conversationId]?.everything === true) {
        return true;
    }
    return autoApproveOf((id) => grants[id]?.autoApprove === true, parentOf, conversationId) !== undefined;
};

/** Who started a conversation, by the registry's entry for it: the parent a mark reaches down from. */
export const supervisorIn =
    (entryOf: (id: string) => { readonly identity: Parameters<typeof supervisorOf>[0] } | undefined) =>
    (id: string): string | undefined => {
        const entry = entryOf(id);
        return entry === undefined ? undefined : supervisorOf(entry.identity);
    };

// The grants as the card registry reads them: all of them for a card's answer, and the one write a card's "everything"
// makes. Read through a getter, since the store is composed after the registry that reads it.
interface StandingGrants {
    readonly all: () => Promise<Readonly<Record<string, ConversationGrant>>>;
    readonly allowEverything: (conversationId: string, by: string | undefined) => Promise<void>;
}

// What the card registry asks of the standing answers (its `StandingYes`, spelled here so the grants need not import it).
interface GrantsStanding {
    readonly allowed: (conversationId: string, hardRule: boolean) => Promise<boolean>;
    readonly allow: (conversationId: string, by: string | undefined) => Promise<void>;
    readonly failed: (cause: unknown) => void;
}

/** The card registry's standing answers over the conversation grants, the mark followed up `parentOf`. */
export const grantsStanding = (grants: () => StandingGrants, parentOf: (id: string) => string | undefined, failed: (cause: unknown) => void): GrantsStanding => ({
    allowed: async (conversationId, hardRule) => standingAnswers(await grants().all(), parentOf, conversationId, hardRule),
    allow: (conversationId, by) => grants().allowEverything(conversationId, by),
    failed,
});
