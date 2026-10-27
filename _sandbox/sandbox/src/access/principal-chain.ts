import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { CredentialReach } from "@intentic/sandbox-contract/schemas/members";
import type { OrgCeiling } from "@intentic/sandbox-contract/schemas/organisation";
import type { Service } from "@intentic/sandbox-contract/schemas/services";
import type { ToolCeiling } from "@intentic/sandbox-contract/schemas/tool-ceiling";
import { errorMessage } from "@intentic/base/errors";
import type { Member } from "../auth/auth.js";
import { parentOfActor } from "../auth/principal.js";

/* WHO A CONVERSATION ACTS FOR, RESOLVED TO THE LIMITS EACH OF THEM HOLDS (docs/architecture/access.md).
 *
 * A conversation latches `people` (everyone who asked it for a turn) and `services` (every service a turn ran as), its
 * own and, through its starter, its parents' (conversations/actor/identity-latch.ts). Each turns into one or more limits:
 *   - a person: their roster row. The owner holds every answer; anyone on the roster what their row says, absent
 *     answers being no limit (a maintainer runs every tool, but may be held to some AI accounts, connections and
 *     secrets); someone the roster no longer names nothing at all, since a conversation must not keep spending for
 *     somebody whose access was taken back;
 *   - a service: its steward, as a person above, and its access profile. A service, steward or profile that no longer
 *     exists reaches nothing, never everything;
 *   - a bound sandbox's organisation: its ceiling on tools and AI accounts, held over every turn, the owner's included.
 * What the conversation may reach is what every limit allows (secrets/credential-reach.ts reads credentials and AI
 * accounts off this, the turn's premise the tool ceiling). Read live on every use, so narrowing any of them holds from
 * the next exit. */

// One principal's answers, in the shape every reader intersects: `all` and undefined are no limit.
export interface ChainLimit {
    // Who this limit is, in the words a refusal names it with: an address, or `the service "x"`.
    readonly who: string;
    readonly credentials: CredentialReach | "all";
    readonly aiAccounts: readonly string[] | "all";
    readonly tools: ToolCeiling | undefined;
}

// `open`: nothing limits the conversation (nobody, or the owner alone, and no organisation ceiling). `unreadable`: a file
// the answer depends on could not be read, which reaches nothing rather than everything. `limits`: every limit to hold.
export type PrincipalChain =
    | { readonly kind: "open" }
    | { readonly kind: "unreadable"; readonly who: readonly string[]; readonly detail: string }
    | { readonly kind: "limits"; readonly limits: readonly ChainLimit[] };

const CHAIN_OPEN: PrincipalChain = { kind: "open" };

const NOTHING: Pick<ChainLimit, "credentials" | "aiAccounts" | "tools"> = { credentials: { capabilities: [], secrets: [] }, aiAccounts: [], tools: undefined };
const EVERYTHING: Pick<ChainLimit, "credentials" | "aiAccounts" | "tools"> = { credentials: "all", aiAccounts: "all", tools: undefined };

const lower = (email: string): string => email.toLowerCase();

// The parts of a conversation's record this reads: who it latched, and the conversation its starter names when an agent
// opened it (a spawned child's parent).
export interface ChainEntry {
    readonly identity: {
        readonly people?: readonly string[] | undefined;
        readonly services?: readonly string[] | undefined;
        readonly startedBy?: string | undefined;
    };
    readonly social: { readonly owner?: { readonly email: string } | undefined };
}

// Everyone and every service a conversation acts for.
export interface ConversationPrincipals {
    readonly people: string[];
    readonly services: string[];
}

/** Everyone and every service a conversation acts for, its own and its parents', read live so a parent's reach its children. */
export const principalsOf = (entryOf: (id: string) => ChainEntry | undefined, conversationId: string | undefined): ConversationPrincipals => {
    const people = new Set<string>();
    const services = new Set<string>();
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
        for (const service of entry.identity.services ?? []) {
            services.add(service);
        }
        id = parentOfActor(entry.identity.startedBy);
    }
    return { people: [...people], services: [...services] };
};

/**
 * One person's limit off the roster: the owner nothing, anyone on it their row (a maintainer with no tool ceiling, since
 * that tier runs every tool), a stranger everything withheld.
 */
export const personLimit = (email: string, roster: readonly Member[], owner: string | undefined): ChainLimit => {
    const address = lower(email);
    if (owner !== undefined && lower(owner) === address) {
        return { who: address, ...EVERYTHING };
    }
    const member = roster.find((row) => lower(row.email) === address);
    if (member === undefined) {
        return { who: address, ...NOTHING };
    }
    return {
        who: address,
        credentials: member.credentials ?? "all",
        aiAccounts: member.aiAccounts ?? "all",
        tools: member.role === "maintainer" ? undefined : member.tools,
    };
};

/** The words a refusal names a service with. */
const serviceWho = (id: string, service: Pick<Service, "label"> | undefined): string => `the service "${service?.label ?? id}"`;

/** A profile's answers as a limit; absent answers are no limit, like a roster row's. */
const profileLimit = (who: string, profile: Pick<AccessProfile, "credentials" | "aiAccounts" | "tools">): ChainLimit => ({
    who,
    credentials: profile.credentials ?? "all",
    aiAccounts: profile.aiAccounts ?? "all",
    tools: profile.tools,
});

/**
 * A service's limits: its steward's, then its profile's. A service, a profile or a steward that is gone limits to nothing:
 * whatever still runs as it reaches nothing until someone points it elsewhere.
 */
export const serviceLimits = (
    id: string,
    service: Service | undefined,
    profiles: readonly Pick<AccessProfile, "id" | "credentials" | "aiAccounts" | "tools">[],
    roster: readonly Member[],
    owner: string | undefined,
): ChainLimit[] => {
    const who = serviceWho(id, service);
    if (service === undefined) {
        return [{ who, ...NOTHING }];
    }
    const steward = personLimit(service.steward, roster, owner);
    if (service.profile === undefined) {
        return [{ ...steward, who: `${who} (for ${lower(service.steward)})` }];
    }
    const profile = profiles.find((entry) => entry.id === service.profile);
    return [{ ...steward, who: `${who} (for ${lower(service.steward)})` }, profile === undefined ? { who, ...NOTHING } : profileLimit(who, profile)];
};

/** The organisation's ceiling as a limit, or undefined when the policy carries none. */
export const orgLimit = (ceiling: OrgCeiling | undefined, orgName: string): ChainLimit | undefined =>
    ceiling === undefined || (ceiling.tools === undefined && ceiling.aiAccounts === undefined)
        ? undefined
        : { who: `the organisation "${orgName}"`, credentials: "all", aiAccounts: ceiling.aiAccounts ?? "all", tools: ceiling.tools };

export interface PrincipalChainDeps {
    readonly members: { readonly list: () => Promise<readonly Member[]> };
    readonly ownerEmail: () => Promise<string | undefined>;
    readonly entry: (id: string) => ChainEntry | undefined;
    // Absent in a composition with no services (a test, a tool): a conversation naming one then reaches nothing.
    readonly services?: { readonly list: () => Promise<readonly Service[]> } | undefined;
    readonly profiles?: { readonly list: () => Promise<readonly AccessProfile[]> } | undefined;
    readonly org?: { readonly current: () => Promise<{ readonly orgName: string; readonly ceiling?: OrgCeiling | undefined } | undefined> } | undefined;
}

// What a turn starting now adds before the conversation has recorded it: the person asking, the service it runs as.
export interface ChainAlso {
    readonly people?: readonly string[] | undefined;
    readonly services?: readonly string[] | undefined;
}

export type PrincipalChainOf = (conversationId: string | undefined, also?: ChainAlso) => Promise<PrincipalChain>;

// The people and services a chain is resolved from, nobody limited (none, or the owner alone, and no service) answered
// without reading the roster, as before services existed.
const resolveLimits = async (
    deps: PrincipalChainDeps,
    people: readonly string[],
    serviceIds: readonly string[],
): Promise<readonly ChainLimit[] | "open"> => {
    const owner = await deps.ownerEmail();
    const ownerAddress = owner === undefined ? undefined : lower(owner);
    if (serviceIds.length === 0 && people.every((email) => email === ownerAddress)) {
        return "open";
    }
    const [roster, services, profiles] = await Promise.all([
        deps.members.list(),
        serviceIds.length === 0 ? [] : (deps.services?.list() ?? []),
        serviceIds.length === 0 ? [] : (deps.profiles?.list() ?? []),
    ]);
    return [
        ...people.map((email) => personLimit(email, roster, owner)),
        ...serviceIds.flatMap((id) => serviceLimits(id, services.find((service) => service.id === id), profiles, roster, owner)),
    ];
};

export const createPrincipalChain =
    (deps: PrincipalChainDeps): PrincipalChainOf =>
    async (conversationId, also = {}) => {
        const latched = principalsOf(deps.entry, conversationId);
        const people = [...new Set([...latched.people, ...(also.people ?? []).map(lower)])];
        const serviceIds = [...new Set([...latched.services, ...(also.services ?? [])])];
        let org: ChainLimit | undefined;
        try {
            const policy = await deps.org?.current();
            org = policy === undefined ? undefined : orgLimit(policy.ceiling, policy.orgName);
            const limits = await resolveLimits(deps, people, serviceIds);
            if (limits === "open") {
                return org === undefined ? CHAIN_OPEN : { kind: "limits", limits: [org] };
            }
            const all = org === undefined ? limits : [...limits, org];
            return all.length === 0 ? CHAIN_OPEN : { kind: "limits", limits: all };
        } catch (error) {
            return { kind: "unreadable", who: [...people, ...serviceIds.map((id) => serviceWho(id, undefined))], detail: errorMessage(error) };
        }
    };
