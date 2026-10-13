import { type CapabilityKind, type CredentialGateKind, type CredentialReach, REACHABLE_CREDENTIAL_KINDS } from "@intentic/sandbox-contract";
import type { Member } from "../auth/auth.js";
import { parentOfActor } from "../auth/principal.js";

// WHAT A CONVERSATION MAY SPEND, as the people it works for may. The owner grants each member a reach (the capabilities
// and stored secrets their conversations may use, auth.ts `Member.credentials`), and a conversation holds only what
// EVERY person who has asked it for a turn holds: the latched `people` on its identity (agents-registry.ts), with the
// conversation a spawned child or a peer's message speaks for. Read live from the roster on every use, so a reach the
// owner narrows holds from the next exit, mid-turn included.
// This is the hard half of a person's access, the one no card lifts: a capability outside the reach is never mounted
// for the turn (turn-decision.ts), its variables and skill are left out (honoured.ts), and every exit that spends a
// credential refuses it at the one gate they share (gates/credential-gate.ts). The approver gates are the soft half:
// a person's click releases those.

// `all`: nobody in the conversation is limited. `some`: only these, with `who` the people whose reach made it so, and
// `unreadable` when the roster could not be read, which reaches nothing rather than everything.
export type ConversationReach =
    | { readonly kind: "all" }
    | {
          readonly kind: "some";
          readonly capabilities: ReadonlySet<string>;
          readonly secrets: ReadonlySet<string>;
          readonly who: readonly string[];
          readonly unreadable?: string;
      };

export const REACH_ALL: ConversationReach = { kind: "all" };

const lower = (email: string): string => email.toLowerCase();

// One person's reach: the owner and a maintainer every credential, a member what their row says (absent: every one),
// and anyone the roster no longer names nothing at all, since a conversation must not keep spending for somebody whose
// access was taken back.
const personReach = (email: string, roster: readonly Member[], owner: string | undefined): CredentialReach | "all" => {
    if (owner !== undefined && lower(owner) === email) {
        return "all";
    }
    const member = roster.find((row) => lower(row.email) === email);
    if (member === undefined) {
        return { capabilities: [], secrets: [] };
    }
    return member.role === "maintainer" || member.credentials === undefined ? "all" : member.credentials;
};

/** What a conversation acting for these people may spend: the intersection of each one's reach. */
export const reachOfPeople = (people: readonly string[], roster: readonly Member[], owner: string | undefined): ConversationReach => {
    let capabilities: Set<string> | undefined;
    let secrets: Set<string> | undefined;
    const who: string[] = [];
    for (const email of new Set(people.map(lower))) {
        const reach = personReach(email, roster, owner);
        if (reach === "all") {
            continue;
        }
        who.push(email);
        capabilities = new Set(reach.capabilities.filter((id) => capabilities === undefined || capabilities.has(id)));
        secrets = new Set(reach.secrets.filter((name) => secrets === undefined || secrets.has(name)));
    }
    return capabilities === undefined || secrets === undefined ? REACH_ALL : { kind: "some", capabilities, secrets, who };
};

/** Whether a reach covers one subject, in the gates' own vocabulary: a capability id, or a stored secret's name. */
export const reachAllows = (reach: ConversationReach, kind: CredentialGateKind, subject: string): boolean => {
    if (reach.kind === "all") {
        return true;
    }
    return kind === "capability" ? reach.capabilities.has(subject) : reach.secrets.has(subject);
};

/** Whether a reach decides a capability of this kind at all; the rest hold nothing a turn could be denied. */
export const reachDecides = (kind: CapabilityKind): boolean => REACHABLE_CREDENTIAL_KINDS.includes(kind);

/** A turn's capabilities split by a reach: what it keeps, and what it decides the turn does not get. */
export interface ReachSplit<C> {
    readonly kept: C[];
    readonly withheld: C[];
}

export const withinReach = <C extends { readonly id: string; readonly kind: CapabilityKind }>(capabilities: readonly C[], reach: ConversationReach): ReachSplit<C> => {
    const kept: C[] = [];
    const withheld: C[] = [];
    for (const capability of capabilities) {
        (reachDecides(capability.kind) && !reachAllows(reach, "capability", capability.id) ? withheld : kept).push(capability);
    }
    return { kept, withheld };
};

// The parts of a conversation's record this reads: its own people, and the conversation its starter names when an
// agent opened it (a spawned child's parent).
interface ReachEntry {
    readonly identity: { readonly people?: readonly string[] | undefined; readonly startedBy?: string | undefined };
    readonly social: { readonly owner?: { readonly email: string } | undefined };
}

/** Everyone a conversation acts for, its own and its parents', read live so a parent's new person reaches its children. */
export const peopleOf = (entryOf: (id: string) => ReachEntry | undefined, conversationId: string | undefined): string[] => {
    const people = new Set<string>();
    const seen = new Set<string>();
    let id = conversationId;
    while (id !== undefined && !seen.has(id)) {
        seen.add(id);
        const entry = entryOf(id);
        if (entry === undefined) {
            break;
        }
        // A row written before `people` existed names the member it belongs to.
        for (const email of entry.identity.people ?? (entry.social.owner === undefined ? [] : [entry.social.owner.email])) {
            people.add(lower(email));
        }
        id = parentOfActor(entry.identity.startedBy);
    }
    return [...people];
};

export interface CredentialReachDeps {
    readonly members: { readonly list: () => Promise<readonly Member[]> };
    readonly ownerEmail: () => Promise<string | undefined>;
    readonly entry: (id: string) => ReachEntry | undefined;
}

// Resolves a conversation's reach, with `also` for a person whose turn is starting before the conversation has recorded
// them. No conversation (an automation's own check, a detached shell) and nobody limited both answer `all`, with no
// roster read; a roster that cannot be read answers nothing, never everything.
export type ConversationReachOf = (conversationId: string | undefined, also?: readonly string[]) => Promise<ConversationReach>;

export const createConversationReach =
    (deps: CredentialReachDeps): ConversationReachOf =>
    async (conversationId, also = []) => {
        const people = [...new Set([...peopleOf(deps.entry, conversationId), ...also.map(lower)])];
        if (people.length === 0) {
            return REACH_ALL;
        }
        let owner: string | undefined;
        let roster: readonly Member[];
        try {
            owner = await deps.ownerEmail();
            const ownerAddress = owner === undefined ? undefined : lower(owner);
            if (people.every((email) => email === ownerAddress)) {
                return REACH_ALL;
            }
            roster = await deps.members.list();
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return { kind: "some", capabilities: new Set(), secrets: new Set(), who: people, unreadable: detail };
        }
        return reachOfPeople(people, roster, owner);
    };

const naming = (who: readonly string[]): string =>
    who.length <= 1 ? (who[0] ?? "the person this conversation works for") : `${who.slice(0, -1).join(", ")} and ${who.at(-1) ?? ""}`;

/** The refusal an exit answers with for a subject outside the reach: final, and nothing to ask anybody for. */
export const outOfReachReason = (reach: Extract<ConversationReach, { kind: "some" }>, subject: string): string =>
    reach.unreadable !== undefined
        ? `"${subject}" was not used: the sandbox's member roster could not be read, so what this conversation may spend is unknown and nothing is spent on a guess. Do not retry: tell the user the roster is unreadable.`
        : `"${subject}" is not available in this conversation: ${naming(reach.who)} ${reach.who.length > 1 ? "were" : "was"} not given it, and a conversation can use only what every person in it may. ` +
          `No card can release it and \`secrets request\` cannot ask for it: only the sandbox owner can change who may use what, on the Access page. ` +
          `Do not retry and do not look for another way to it: carry on without it and say plainly what you left undone.`;

/** A turn's shell environment without the variables of the cli connectors a reach withholds, gateway addresses and all. */
export const reachCliEnv = (
    cliEnv: Record<string, string>,
    withheld: readonly { readonly id: string; readonly kind: CapabilityKind }[],
    envSuffix: (id: string) => string,
): Record<string, string> => {
    const denied = withheld.filter((capability) => capability.kind === "cli").map((capability) => `_${envSuffix(capability.id)}`);
    if (denied.length === 0) {
        return cliEnv;
    }
    return Object.fromEntries(Object.entries(cliEnv).filter(([key]) => !denied.some((suffix) => key.endsWith(suffix))));
};

export const OUT_OF_REACH_TITLE = "Some connected accounts are not available in this conversation";

/** What the model reads about a withheld capability: connected and fine, not for this conversation, and nothing to ask. */
export const outOfReachNote = (
    reach: ConversationReach,
    withheld: readonly { readonly id: string }[],
): { readonly title: string; readonly text: string } | undefined => {
    if (reach.kind === "all" || (withheld.length === 0 && reach.secrets.size === 0 && reach.unreadable === undefined)) {
        return undefined;
    }
    const names = withheld.map((capability) => `\`${capability.id}\``).join(", ");
    return {
        title: OUT_OF_REACH_TITLE,
        text:
            `${(reach.unreadable === undefined
                ? `${naming(reach.who)} ${reach.who.length > 1 ? "were" : "was"} given access to only some of this sandbox's connected accounts and stored secrets, and a conversation can use only what every person in it may. `
                : "The sandbox's member roster could not be read, so no connected account or stored secret is available in this conversation until it can be. ") +
            (names === "" ? "" : `Not loaded here: ${names}. They are connected and working; they are left out on purpose. `) 
            }A \`{{secret:…}}\` reference to anything outside what this conversation may use is refused. Do not ask to connect these again, do not raise \`secrets request\` or \`capabilities request\` for them, and do not look for another way to them: ` +
            `only the sandbox owner decides who may use what, on the Access page. Carry on without them and say plainly what you left undone.`,
    };
};
