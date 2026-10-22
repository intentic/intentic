import type { PersistedAgent } from "../conversations/registry/agents-store.js";
import { supervisorOf } from "../auth/principal.js";
import { turnFinished } from "./notifications.js";
import type { PushSender } from "./push.js";

// WHO A CONVERSATION'S PUSHES ARE FOR. Every member who is away, for an ordinary conversation, as before. A home
// conversation (conversations/home/) is one person's chat with the sandbox, so its news and its family's go to that person
// alone; and a subagent of a home finishing is the home's news, not a person's: the home is woken with its report and
// judges it, so its owner is told only what the home itself ends with, or what only a person can answer (a card, a need).

export type PushAudience = { readonly kind: "everyone" } | { readonly kind: "member"; readonly email: string } | { readonly kind: "nobody" };

const EVERYONE: PushAudience = { kind: "everyone" };
// Deeper than any family spawn depth allows; a cycle in a corrupt record must not spin.
const MOST_ANCESTORS = 16;

// The home this conversation is, or descends from, by who supervises whom (agents-store.ts supervisorOf).
const homeAbove = (entryOf: (id: string) => PersistedAgent | undefined, conversationId: string): { readonly home: PersistedAgent; readonly self: boolean } | undefined => {
    let id: string | undefined = conversationId;
    for (let step = 0; id !== undefined && step < MOST_ANCESTORS; step += 1) {
        const entry = entryOf(id);
        if (entry === undefined) {
            return undefined;
        }
        if (entry.identity.home === true) {
            return { home: entry, self: step === 0 };
        }
        id = supervisorOf(entry.identity);
    }
    return undefined;
};

/** Who hears that a turn finished: a home's owner for the home, nobody for its subagents, everyone else as ever. */
export const finishedAudience = (entryOf: (id: string) => PersistedAgent | undefined, conversationId: string): PushAudience => {
    const above = homeAbove(entryOf, conversationId);
    const owner = above?.home.social.owner?.email;
    if (above === undefined || owner === undefined) {
        return EVERYONE;
    }
    return above.self ? { kind: "member", email: owner } : { kind: "nobody" };
};

/** Who hears that a card or a need waits on a person: in a home's family, its owner alone (undefined: everyone away). */
export const askedOf = (entryOf: (id: string) => PersistedAgent | undefined, conversationId: string): string | undefined =>
    homeAbove(entryOf, conversationId)?.home.social.owner?.email;

/** The member a send is narrowed to, or `false` for one nobody should get. */
const audienceTo = (audience: PushAudience): string | undefined | false =>
    audience.kind === "nobody" ? false : audience.kind === "member" ? audience.email : undefined;

/** A finished turn's push, to whoever `finishedAudience` names; nothing at all for a home's subagent. */
export const notifyTurnFinished = async (
    services: { readonly agents: { readonly entry: (id: string) => PersistedAgent | undefined }; readonly pushSender: Pick<PushSender, "notifyIfAway"> },
    conversationId: string,
    prompt: string,
    outcome: { ok: boolean; error?: string },
): Promise<void> => {
    const to = audienceTo(finishedAudience(services.agents.entry, conversationId));
    if (to !== false) {
        await services.pushSender.notifyIfAway(turnFinished(conversationId, prompt, outcome), to);
    }
};
