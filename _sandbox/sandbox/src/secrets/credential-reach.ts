import type { CapabilityKind } from "@intentic/sandbox-contract/schemas/capabilities";
import type { CredentialGateKind } from "@intentic/sandbox-contract/schemas/secrets";
import { aiAccountAllowed, REACHABLE_CREDENTIAL_KINDS } from "@intentic/sandbox-contract/schemas/members";
import { intersectCeilings, type ToolCeiling } from "@intentic/sandbox-contract/schemas/tool-ceiling";
import type { Member } from "../auth/auth.js";
import {
    type ChainEntry,
    type ChainLimit,
    createPrincipalChain,
    type PrincipalChain,
    type PrincipalChainDeps,
    personLimit,
    principalsOf,
} from "../access/principal-chain.js";

// WHAT A CONVERSATION MAY SPEND, as everyone it acts for may (docs/architecture/access.md). The owner grants each member a
// reach (the capabilities and stored secrets their conversations may use, auth.ts `Member.credentials`), a service holds
// its steward's narrowed by its access profile, and a conversation holds only what EVERY principal it latched holds
// (access/principal-chain.ts): the people who asked it for a turn and the services its turns ran as, with the
// conversation a spawned child or a peer's message speaks for. Read live on every use, so a reach the owner narrows
// holds from the next exit, mid-turn included.
// This is the hard half of access, the one no card lifts: a capability outside the reach is never mounted for the turn
// (turn-decision.ts), its variables and skill are left out (honoured.ts), and every exit that spends a credential refuses
// it at the one gate they share (gates/credential-gate.ts). The approver gates are the soft half: a person's click
// releases those.

// `all`: nobody in the conversation is limited. `some`: only these, with `who` the principals whose reach made it so, and
// `unreadable` when a file the answer depends on could not be read, which reaches nothing rather than everything.
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

/** What a conversation held to these limits may spend: the intersection of every limit that lists any. */
const reachOfLimits = (limits: readonly ChainLimit[]): ConversationReach => {
    let capabilities: Set<string> | undefined;
    let secrets: Set<string> | undefined;
    const who: string[] = [];
    for (const limit of limits) {
        const reach = limit.credentials;
        if (reach === "all") {
            continue;
        }
        who.push(limit.who);
        capabilities = new Set(reach.capabilities.filter((id) => capabilities === undefined || capabilities.has(id)));
        secrets = new Set(reach.secrets.filter((name) => secrets === undefined || secrets.has(name)));
    }
    return capabilities === undefined || secrets === undefined ? REACH_ALL : { kind: "some", capabilities, secrets, who: [...new Set(who)] };
};

/** What a conversation acting for these people alone may spend: the intersection of each one's reach. */
export const reachOfPeople = (people: readonly string[], roster: readonly Member[], owner: string | undefined): ConversationReach =>
    reachOfLimits([...new Set(people.map((email) => email.toLowerCase()))].map((email) => personLimit(email, roster, owner)));

/** A chain's reach: open reaches everything, unreadable nothing. */
const reachOfChain = (chain: PrincipalChain): ConversationReach => {
    if (chain.kind === "open") {
        return REACH_ALL;
    }
    if (chain.kind === "unreadable") {
        return { kind: "some", capabilities: new Set(), secrets: new Set(), who: chain.who, unreadable: chain.detail };
    }
    return reachOfLimits(chain.limits);
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

/** Everyone a conversation acts for, its own and its parents', read live so a parent's new person reaches its children. */
export const peopleOf = (entryOf: (id: string) => ChainEntry | undefined, conversationId: string | undefined): string[] =>
    principalsOf(entryOf, conversationId).people;

export type CredentialReachDeps = PrincipalChainDeps;

// Resolves a conversation's reach, with `also` for a person and `services` for a service whose turn is starting before
// the conversation has recorded them. No conversation (an automation's own check, a detached shell) and nobody limited
// both answer `all`, with no roster read; a file that cannot be read answers nothing, never everything.
export type ConversationReachOf = (conversationId: string | undefined, also?: readonly string[], services?: readonly string[]) => Promise<ConversationReach>;

export const createConversationReach = (deps: CredentialReachDeps): ConversationReachOf => {
    const chain = createPrincipalChain(deps);
    return async (conversationId, also = [], services = []) => reachOfChain(await chain(conversationId, { people: also, services }));
};

// WHICH AI ACCOUNTS A CONVERSATION MAY RUN ON, as everyone it acts for may (auth.ts `Member.aiAccounts`, a profile's
// `aiAccounts`, an organisation's ceiling): the same chain and the same rule as the reach above, applied to the model
// accounts that pay for its turns rather than to what its agent works with. Kept as one list per limit rather than one
// intersected set, since a key may name a whole provider (`claude`) where another limit names one account of it
// (`claude:work`): an account is allowed when every list allows it (agent/run/decide/account-reach.ts decides the turn).

export type AccountReach =
    | { readonly kind: "all" }
    | {
          readonly kind: "some";
          readonly lists: readonly ReadonlySet<string>[];
          readonly who: readonly string[];
          readonly unreadable?: string;
      };

export const ACCOUNTS_ALL: AccountReach = { kind: "all" };

/** The AI accounts a conversation held to these limits may run on: every list that limits, each of which must allow. */
const accountReachOfLimits = (limits: readonly ChainLimit[]): AccountReach => {
    const lists: ReadonlySet<string>[] = [];
    const who: string[] = [];
    for (const limit of limits) {
        if (limit.aiAccounts !== "all") {
            lists.push(new Set(limit.aiAccounts));
            who.push(limit.who);
        }
    }
    return lists.length === 0 ? ACCOUNTS_ALL : { kind: "some", lists, who: [...new Set(who)] };
};

/** The AI accounts a conversation acting for these people alone may run on. */
export const accountReachOfPeople = (people: readonly string[], roster: readonly Member[], owner: string | undefined): AccountReach =>
    accountReachOfLimits([...new Set(people.map((email) => email.toLowerCase()))].map((email) => personLimit(email, roster, owner)));

/** A chain's AI accounts: open runs on every one, unreadable on none. */
const accountReachOfChain = (chain: PrincipalChain): AccountReach => {
    if (chain.kind === "open") {
        return ACCOUNTS_ALL;
    }
    if (chain.kind === "unreadable") {
        return { kind: "some", lists: [], who: chain.who, unreadable: chain.detail };
    }
    return accountReachOfLimits(chain.limits);
};

/** Whether a reach lets a turn run on one account of a provider; `account` undefined asks about the provider as a whole. */
export const accountReachAllows = (reach: AccountReach, provider: string, account: string | undefined): boolean =>
    reach.kind === "all" || (reach.unreadable === undefined && reach.lists.every((list) => aiAccountAllowed(list, provider, account)));

export type ConversationAccountReachOf = (
    conversationId: string | undefined,
    also?: readonly string[],
    services?: readonly string[],
) => Promise<AccountReach>;

// No conversation and nobody limited both answer `all`; a file that cannot be read answers no account, never every one.
export const createConversationAccountReach = (deps: CredentialReachDeps): ConversationAccountReachOf => {
    const chain = createPrincipalChain(deps);
    return async (conversationId, also = [], services = []) => accountReachOfChain(await chain(conversationId, { people: also, services }));
};

// THE MOST A CONVERSATION'S TOOLS MAY BE, from the same chain: every limit's ceiling held together. Undefined is no
// ceiling. A chain that cannot be read answers no ceiling here: its AI accounts already answer none, so no turn runs on it.
const ceilingOfChain = (chain: PrincipalChain): ToolCeiling | undefined =>
    chain.kind === "limits" ? chain.limits.reduce<ToolCeiling | undefined>((held, limit) => intersectCeilings(held, limit.tools), undefined) : undefined;

export type ConversationCeilingOf = (
    conversationId: string | undefined,
    also?: readonly string[],
    services?: readonly string[],
) => Promise<ToolCeiling | undefined>;

export const createConversationCeiling = (deps: CredentialReachDeps): ConversationCeilingOf => {
    const chain = createPrincipalChain(deps);
    return async (conversationId, also = [], services = []) => ceilingOfChain(await chain(conversationId, { people: also, services }));
};

const naming = (who: readonly string[]): string =>
    who.length <= 1 ? (who[0] ?? "the person this conversation works for") : `${who.slice(0, -1).join(", ")} and ${who.at(-1) ?? ""}`;

/** Who a reach names, in a sentence: the people whose lists narrowed it. */
export const reachWho = (who: readonly string[]): string => naming(who);

/** The refusal an exit answers with for a subject outside the reach: final, and nothing to ask anybody for. */
export const outOfReachReason = (reach: Extract<ConversationReach, { kind: "some" }>, subject: string): string =>
    reach.unreadable !== undefined
        ? `"${subject}" was not used: the sandbox's record of who this conversation acts for (its roster, services or access profiles) could not be read, so what it may spend is unknown and nothing is spent on a guess. Do not retry: tell the user that record is unreadable.`
        : `"${subject}" is not available in this conversation: ${naming(reach.who)} ${reach.who.length > 1 ? "were" : "was"} not given it, and a conversation can use only what everyone it acts for may. ` +
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
                ? `${naming(reach.who)} ${reach.who.length > 1 ? "were" : "was"} given access to only some of this sandbox's connected accounts and stored secrets, and a conversation can use only what everyone it acts for may. `
                : "The sandbox's record of who this conversation acts for could not be read, so no connected account or stored secret is available in this conversation until it can be. ") +
            (names === "" ? "" : `Not loaded here: ${names}. They are connected and working; they are left out on purpose. `) 
            }A \`{{secret:…}}\` reference to anything outside what this conversation may use is refused. Do not ask to connect these again, do not raise \`secrets request\` or \`capabilities request\` for them, and do not look for another way to them: ` +
            `only the sandbox owner decides who may use what, on the Access page. Carry on without them and say plainly what you left undone.`,
    };
};
