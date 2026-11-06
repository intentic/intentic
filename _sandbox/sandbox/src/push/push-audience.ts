import { audienceOf, recordFacts } from "@intentic/sandbox-contract/schemas/agent-people";
import type { PersistedAgent } from "../conversations/registry/agents-store.js";
import { provenanceOf, type Provenance } from "../auth/fleet-scope.js";
import { parentOfActor, supervisorOf } from "../auth/principal.js";
import { opt } from "../opt.js";
import { turnFinished } from "./notifications.js";
import type { PushSender } from "./push.js";

// WHO A PUSH IS FOR. Every send names its people; nothing goes to "everyone in the sandbox" any more (until 2026-11-06 a
// shared conversation's news went to every member who was away, guests and fenced members included, its prompt with it).
// - A conversation's news is for the people who took part in it and have not turned it off (sandbox-contract
//   schemas/agent-people.ts), and `about` names the conversation so the sender drops anyone it is hidden from
//   (push.ts, auth/fleet-scope.ts visibleTo): a guest, a fenced member, a reader a seal keeps out.
// - The sandbox's own news (its disk, its address, a held wake or link task) is for its operators: its owner and
//   maintainers, the people who can act on it.

export type Audience =
    | { readonly kind: "people"; readonly emails: readonly string[]; readonly about?: Provenance | undefined }
    | { readonly kind: "operators"; readonly about?: Provenance | undefined };

export const OPERATORS: Audience = { kind: "operators" };

/** These people, each once, about this conversation when it names one. */
export const peopleAudience = (emails: readonly string[], about?: Provenance): Audience => ({
    kind: "people",
    emails: [...new Set(emails.map((email) => email.toLowerCase()))],
    ...opt("about", about),
});

// Deeper than any family spawn depth allows; a cycle in a corrupt record must not spin.
const MOST_ANCESTORS = 16;

// The conversation a person opened that this one reports to: itself, or the top of the chain of supervisors above a
// subagent or a fresh review (principal.ts supervisorOf). Its people are the ones a card down the family waits on.
const reportsTo = (entryOf: (id: string) => PersistedAgent | undefined, entry: PersistedAgent): PersistedAgent => {
    let top = entry;
    for (let step = 0; step < MOST_ANCESTORS; step += 1) {
        const above = supervisorOf(top.identity);
        const next = above === undefined ? undefined : entryOf(above);
        if (next === undefined) {
            return top;
        }
        top = next;
    }
    return top;
};

/**
 * Who hears that a turn finished: the people who took part, asking for everything of it. Nobody for a subagent or a
 * fresh review, whose ending wakes the conversation it reports to, which judges it and says what it ends with; nobody for
 * a conversation an outside message opened, which answers whoever wrote in. Undefined when nobody hears it.
 */
export const finishedAudience = (entryOf: (id: string) => PersistedAgent | undefined, conversationId: string): Audience | undefined => {
    const entry = entryOf(conversationId);
    if (entry === undefined || supervisorOf(entry.identity) !== undefined || entry.identity.origin !== undefined) {
        return undefined;
    }
    const emails = audienceOf(recordFacts(entry), "finished");
    return emails.length === 0 ? undefined : peopleAudience(emails, provenanceOf(entry));
};

/**
 * Who hears that a card or a need waits on a person: the people of the conversation it reports to who did not turn it
 * off; the sandbox's operators when that is nobody, since a card nobody hears is an agent stopped for good. A credential
 * to release goes to the people named on it alone, whoever they are. Always about the conversation that asks.
 */
export const askedAudience = (entryOf: (id: string) => PersistedAgent | undefined, conversationId: string, approvers?: readonly string[]): Audience => {
    const entry = entryOf(conversationId);
    const about = entry === undefined ? undefined : provenanceOf(entry);
    if (approvers !== undefined && approvers.length > 0) {
        return peopleAudience(approvers, about);
    }
    const emails = entry === undefined ? [] : audienceOf(recordFacts(reportsTo(entryOf, entry)), "asks");
    return emails.length === 0 ? { kind: "operators", ...opt("about", about) } : peopleAudience(emails, about);
};

/**
 * Who an automation's own notices are for (a watch firing or ending, a one-time wake done): whoever made it, a person or
 * the people of the conversation that proposed it; the sandbox's operators for one made before that was kept, or whose
 * maker no longer has anybody to tell.
 */
export const automationAudience = (entryOf: (id: string) => PersistedAgent | undefined, createdBy: string | undefined): Audience => {
    const proposedIn = parentOfActor(createdBy);
    if (proposedIn !== undefined) {
        const entry = entryOf(proposedIn);
        const emails = entry === undefined ? [] : audienceOf(recordFacts(entry), "finished");
        return entry === undefined || emails.length === 0 ? OPERATORS : peopleAudience(emails, provenanceOf(entry));
    }
    return createdBy !== undefined && createdBy.includes("@") ? peopleAudience([createdBy]) : OPERATORS;
};

/** A finished turn's push, to whoever `finishedAudience` names, and to nobody when that is nobody. */
export const notifyTurnFinished = async (
    services: { readonly agents: { readonly entry: (id: string) => PersistedAgent | undefined }; readonly pushSender: Pick<PushSender, "notifyIfAway"> },
    conversationId: string,
    prompt: string,
    outcome: { ok: boolean; error?: string },
): Promise<void> => {
    const to = finishedAudience(services.agents.entry, conversationId);
    if (to !== undefined) {
        await services.pushSender.notifyIfAway(turnFinished(conversationId, prompt, outcome), to);
    }
};
