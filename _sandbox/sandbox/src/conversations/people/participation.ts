import type { NotifyLevel, Participation } from "@intentic/sandbox-contract/schemas/agents";
import { recordFacts, tookPart } from "@intentic/sandbox-contract/schemas/agent-people";
import { starterLook } from "@intentic/sandbox-contract/models/agent-starter";
import type { PersistedAgent } from "../registry/agents-store.js";
import { opt } from "../../opt.js";

// WHO TOOK PART IN A CONVERSATION, and how much of its news each person asked for, as writes on its record
// (sandbox-contract schemas/agent-people.ts reads them). Each answers undefined when nothing would change, so the
// registry writes and broadcasts only a real change: a person's hundredth message is no news to anybody.

export interface Person {
    readonly email: string;
    readonly name?: string | undefined;
}

/** The person who asked for a turn, by its verified starter (an address, not a token or a conversation) and their name. */
export const personAsking = (startedBy: string | undefined, owner: Person | undefined): Person | undefined => {
    if (startedBy === undefined || !startedBy.includes("@") || starterLook(startedBy) !== undefined) {
        return undefined;
    }
    return owner !== undefined && owner.email.toLowerCase() === startedBy.toLowerCase() ? owner : { email: startedBy };
};

/** The record with this person among its participants, or undefined when they already took part. */
export const joinedEntry = (entry: PersistedAgent, person: Person, via: Participation, at: number): PersistedAgent | undefined => {
    if (tookPart(recordFacts(entry), person.email)) {
        return undefined;
    }
    const joined = { email: person.email.toLowerCase(), ...opt("name", person.name), since: at, via };
    return { ...entry, social: { ...entry.social, participants: [...(entry.social.participants ?? []), joined] } };
};

/** The record with this person's answer set (null clears it), or undefined when it already stands. */
export const notifiedEntry = (entry: PersistedAgent, email: string, level: NotifyLevel | null, at: number): PersistedAgent | undefined => {
    const address = email.toLowerCase();
    const held = entry.social.notify ?? [];
    const current = held.find((choice) => choice.email === address);
    if (current?.level === (level ?? undefined)) {
        return undefined;
    }
    const others = held.filter((choice) => choice.email !== address);
    const notify = level === null ? others : [...others, { email: address, level, at }];
    const { notify: _held, ...social } = entry.social;
    return { ...entry, social: notify.length === 0 ? social : { ...social, notify } };
};

// `@` and an address, as a message names a person to bring them in (`@ola@acme.dev`). Read only against the roster, so
// an address nobody holds names nobody.
const MENTION = /(?:^|[^\w@.])@([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;

/** The members a message names with `@`, lowercased, each once, among `members` alone. */
export const mentionedIn = (text: string, members: readonly string[]): string[] => {
    const known = new Set(members.map((email) => email.toLowerCase()));
    const named = [...text.matchAll(MENTION)].map((match) => (match[1] ?? "").replace(/\.$/, "").toLowerCase());
    return [...new Set(named)].filter((email) => known.has(email));
};
