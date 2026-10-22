import { parentOfActor } from "../../auth/principal.js";
import { opt } from "../../opt.js";
import type { BeginTurn } from "./conversation-decide.js";
import type { Identity, PersistedAgent } from "../registry/agents-store.js";

// WHAT A CONVERSATION'S IDENTITY LATCHES as its turns begin (registry/agents-registry.ts `begin`): the fence it was born with,
// everyone whose word it acts on, and the rest of what its opening turn decides once. Out of the registry, which only
// writes these, so the rules can be read in one place.

// The fence it was born with: kept once set, else the opening turn's, else the parent's for a spawned child. A child
// inherits rather than starting unfenced, since a delegate a fenced turn opens is that turn continuing by other means.
// `undefined` is the whole workspace, so a child of an unfenced parent is unfenced too, which is the same answer.
const areasOfConversation = (
    existing: Identity,
    turn: BeginTurn,
    entryOf: (id: string) => PersistedAgent | undefined,
): { readonly areas?: string[] } => {
    if (existing.areas !== undefined) {
        return { areas: [...existing.areas] };
    }
    const parentId = parentOfActor(existing.startedBy ?? turn.startedBy);
    const inherited = turn.areas ?? (parentId === undefined ? undefined : entryOf(parentId)?.identity.areas);
    return inherited === undefined ? {} : { areas: [...inherited] };
};

// Everyone whose word this conversation acts on: kept once set, and grown by each person who asks it for a turn. A turn
// an agent speaks (a spawned child's opening, a peer's message) brings that conversation's people with it, since its
// words are theirs at one remove. Never shrinks: what the conversation may spend is what every one of them may
// (secrets/credential-reach.ts), so a person joining narrows it and nobody leaving widens it. A row from before the field
// starts from the member it belongs to, the one person it can name.
export const peopleOfConversation = (
    held: PersistedAgent,
    turn: BeginTurn,
    entryOf: (id: string) => PersistedAgent | undefined,
): { readonly people?: string[] } => {
    const speaking = parentOfActor(turn.startedBy);
    const joined = [
        ...(held.identity.people ?? (held.social.owner === undefined ? [] : [held.social.owner.email])),
        ...(turn.owner === undefined ? [] : [turn.owner.email]),
        ...(speaking === undefined ? [] : (entryOf(speaking)?.identity.people ?? [])),
    ];
    const people = [...new Set(joined.map((email) => email.toLowerCase()))];
    return people.length === 0 ? {} : { people };
};

// Latched with the conversation: each field keeps the first answer it got, and a later turn's differing persona does
// not move the conversation to another project.
export const identityOf = (existing: Identity, turn: BeginTurn, entryOf: (id: string) => PersistedAgent | undefined): Identity => ({
    ...opt("origin", existing.origin ?? turn.origin),
    ...opt("startedBy", existing.startedBy ?? turn.startedBy),
    ...areasOfConversation(existing, turn, entryOf),
    ...opt("startIn", existing.startIn ?? turn.startIn),
    ...opt("actsAs", existing.actsAs ?? turn.profile.actsAs),
    ...opt("forkedFrom", existing.forkedFrom ?? turn.forkedFrom),
    ...opt("fresh", existing.fresh ?? turn.fresh),
    ...opt("home", existing.home ?? turn.home),
});
