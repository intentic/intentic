import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { Service } from "@intentic/sandbox-contract/schemas/services";
import type { Member } from "../auth/auth.js";
import { FULL_ACCESS_ROLE } from "@intentic/sandbox-contract/schemas/roles";
import { type ChainEntry, createPrincipalChain, orgLimit, roleLimits, personLimit, principalsOf, serviceLimits } from "./principal-chain.js";

// Who a conversation acts for, turned into limits: a person's row, a service's steward and profile, the access profiles
// listing the role it wears, an organisation's ceiling. Anything that cannot be named limits to nothing, never to
// everything.

const OWNER = "ada@example.com";
const NOTHING = { credentials: { capabilities: [], secrets: [] }, aiAccounts: [], tools: undefined };

const roster: Member[] = [
    { email: "bob@example.com", tier: "collaborator", credentials: { capabilities: ["github"], secrets: [] }, aiAccounts: ["claude:work"], tools: { shell: false } },
    { email: "eve@example.com", tier: "maintainer" },
    { email: "fox@example.com", tier: "maintainer", credentials: { capabilities: ["github"], secrets: [] }, aiAccounts: ["claude:work"] },
];

const profiles: AccessProfile[] = [
    { id: "marketing", credentials: { capabilities: ["reddit-work"], secrets: [] }, aiAccounts: ["claude"], tools: { browser: false } },
    // The Reviewer card's own limits, and a profile that lists a built-in (which no picker offers, and the chain ignores).
    { id: "role-reviewer", tools: { files: "read", shell: false }, roles: ["reviewer"] },
    { id: "odd", tools: { web: false }, roles: [FULL_ACCESS_ROLE] },
];
const REVIEWER = { who: `the role "Reviewer"`, credentials: "all", aiAccounts: "all", tools: { files: "read", shell: false }, role: "reviewer" } as const;

const services: Service[] = [
    { id: "bot", label: "Marketing bot", steward: OWNER, profile: "marketing" },
    { id: "bobs", steward: "bob@example.com" },
    { id: "orphan", steward: "gone@example.com" },
    { id: "lost", steward: OWNER, profile: "deleted" },
];

describe("personLimit", () => {
    test("the owner is not limited; anyone on the roster is their row, a maintainer with no tool ceiling", () => {
        expect(personLimit(OWNER, roster, OWNER)).toEqual({ who: OWNER, credentials: "all", aiAccounts: "all", tools: undefined });
        expect(personLimit("eve@example.com", roster, OWNER)).toEqual({ who: "eve@example.com", credentials: "all", aiAccounts: "all", tools: undefined });
        expect(personLimit("fox@example.com", roster, OWNER)).toEqual({
            who: "fox@example.com",
            credentials: { capabilities: ["github"], secrets: [] },
            aiAccounts: ["claude:work"],
            tools: undefined,
        });
        expect(personLimit("Bob@Example.com", roster, OWNER)).toEqual({
            who: "bob@example.com",
            credentials: { capabilities: ["github"], secrets: [] },
            aiAccounts: ["claude:work"],
            tools: { shell: false },
        });
    });

    test("someone the roster no longer names reaches nothing", () => {
        expect(personLimit("gone@example.com", roster, OWNER)).toEqual({ who: "gone@example.com", ...NOTHING });
    });
});

describe("serviceLimits", () => {
    const of = (id: string) => serviceLimits(id, services.find((service) => service.id === id), profiles, roster, OWNER);

    test("a service is its steward's limit and then its profile's", () => {
        expect(of("bot")).toEqual([
            { who: `the service "Marketing bot" (for ${OWNER})`, credentials: "all", aiAccounts: "all", tools: undefined },
            { who: `the service "Marketing bot"`, credentials: { capabilities: ["reddit-work"], secrets: [] }, aiAccounts: ["claude"], tools: { browser: false } },
        ]);
    });

    test("a service with no profile is its steward alone", () => {
        expect(of("bobs")).toEqual([
            {
                who: `the service "bobs" (for bob@example.com)`,
                credentials: { capabilities: ["github"], secrets: [] },
                aiAccounts: ["claude:work"],
                tools: { shell: false },
            },
        ]);
    });

    test("a service that is gone, a steward who left and a profile that is gone each reach nothing", () => {
        expect(serviceLimits("ghost", undefined, profiles, roster, OWNER)).toEqual([{ who: `the service "ghost"`, ...NOTHING }]);
        expect(of("orphan")).toEqual([{ who: `the service "orphan" (for gone@example.com)`, ...NOTHING }]);
        expect(of("lost")[1]).toEqual({ who: `the service "lost"`, ...NOTHING });
    });
});

describe("orgLimit", () => {
    test("an organisation's ceiling is a limit on tools and AI accounts only", () => {
        expect(orgLimit({ tools: { shell: false }, aiAccounts: ["claude"] }, "Office")).toEqual({
            who: `the organisation "Office"`,
            credentials: "all",
            aiAccounts: ["claude"],
            tools: { shell: false },
        });
        expect(orgLimit(undefined, "Office")).toBeUndefined();
        expect(orgLimit({}, "Office")).toBeUndefined();
    });
});

describe("roleLimits", () => {
    test("a card is held to each profile that lists it, said by its name", () => {
        expect(roleLimits("reviewer", "Reviewer", profiles)).toEqual([REVIEWER]);
        // No label to say it by: its id.
        expect(roleLimits("reviewer", undefined, profiles)[0]?.who).toBe(`the role "reviewer"`);
        expect(roleLimits("reviewer", "Reviewer", [...profiles, { id: "second", aiAccounts: ["claude"], roles: ["reviewer"] }])).toHaveLength(2);
    });

    test("a card no profile lists, a built-in and no role at all hold nothing", () => {
        expect(roleLimits("writer", "Writer", profiles)).toEqual([]);
        expect(roleLimits(FULL_ACCESS_ROLE, undefined, profiles)).toEqual([]);
        expect(roleLimits(undefined, undefined, profiles)).toEqual([]);
    });
});

describe("principalsOf", () => {
    const entries = new Map<string, ChainEntry>([
        ["parent", { identity: { people: ["bob@example.com"], services: ["bot"] }, social: {} }],
        ["child", { identity: { people: [OWNER], startedBy: "agent:parent" }, social: {} }],
        ["old", { identity: {}, social: { owner: { email: "Cy@Example.com" } } }],
    ]);
    const entryOf = (id: string): ChainEntry | undefined => entries.get(id);

    test("a child acts for its parent's people and services too, and an old row for its owner", () => {
        expect(principalsOf(entryOf, "child")).toEqual({ people: [OWNER, "bob@example.com"], services: ["bot"] });
        expect(principalsOf(entryOf, "old")).toEqual({ people: ["cy@example.com"], services: [] });
        expect(principalsOf(entryOf, undefined)).toEqual({ people: [], services: [] });
    });
});

describe("createPrincipalChain", () => {
    interface ChainOver {
        readonly org?: { readonly orgName: string; readonly ceiling?: { readonly tools?: { readonly shell?: boolean } } };
        readonly entries?: ReadonlyMap<string, ChainEntry>;
    }
    const chainWith = (over: ChainOver = {}) =>
        createPrincipalChain({
            members: { list: async () => roster },
            ownerEmail: async () => OWNER,
            entry: (id) => over.entries?.get(id),
            services: { list: async () => services },
            profiles: { list: async () => profiles },
            roles: { list: async () => [{ id: "reviewer", label: "Reviewer" }, { id: "writer" }] },
            org: { current: async () => over.org },
        });

    test("the owner alone, with no service and no organisation ceiling, is open", async () => {
        await expect(chainWith()(undefined, { people: [OWNER] })).resolves.toEqual({ kind: "open" });
    });

    test("an organisation ceiling holds even the owner", async () => {
        await expect(chainWith({ org: { orgName: "Office", ceiling: { tools: { shell: false } } } })(undefined, { people: [OWNER] })).resolves.toEqual({
            kind: "limits",
            limits: [{ who: `the organisation "Office"`, credentials: "all", aiAccounts: "all", tools: { shell: false } }],
        });
    });

    test("a turn running as a service is held to its steward and its profile", async () => {
        const chain = await chainWith()(undefined, { services: ["bot"] });
        expect(chain).toMatchObject({ kind: "limits" });
        expect(chain.kind === "limits" ? chain.limits.map((limit) => limit.who) : []).toEqual([`the service "Marketing bot" (for ${OWNER})`, `the service "Marketing bot"`]);
    });

    // A card's limits are access like a person's (2026-11-18): the owner wearing the Reviewer is read-only too.
    test("the role a turn wears adds the limits of the profiles listing it, the owner's own conversation included", async () => {
        await expect(chainWith()(undefined, { people: [OWNER], role: { id: "reviewer" } })).resolves.toEqual({ kind: "limits", limits: [REVIEWER] });
        const bobs = await chainWith()(undefined, { people: ["bob@example.com"], role: { id: "reviewer" } });
        expect(bobs.kind === "limits" ? bobs.limits.map((limit) => limit.who) : []).toEqual(["bob@example.com", `the role "Reviewer"`]);
    });

    test("a role asked as none, a card no profile lists and a built-in add nothing", async () => {
        await expect(chainWith()(undefined, { people: [OWNER], role: { id: undefined } })).resolves.toEqual({ kind: "open" });
        await expect(chainWith()(undefined, { people: [OWNER], role: { id: "writer" } })).resolves.toEqual({ kind: "open" });
        await expect(chainWith()(undefined, { people: [OWNER], role: { id: FULL_ACCESS_ROLE } })).resolves.toEqual({ kind: "open" });
    });

    // An exit mid-turn (a credential gate, a secret's use) names no role: it is held to the one the conversation's
    // last turn wore, read off its record.
    test("with no role named, the one the conversation's last turn wore is read off its record", async () => {
        const entries = new Map<string, ChainEntry>([["conv-1", { profile: { actsAs: "reviewer" }, identity: { people: [OWNER] }, social: {} }]]);
        await expect(chainWith({ entries })("conv-1")).resolves.toEqual({ kind: "limits", limits: [REVIEWER] });
        // Naming one, even none, wins over the record.
        await expect(chainWith({ entries })("conv-1", { role: { id: undefined } })).resolves.toEqual({ kind: "open" });
    });

    test("a roster that cannot be read is unreadable, naming who it was for", async () => {
        const chain = createPrincipalChain({
            members: {
                list: async () => {
                    throw new Error("members.json is not a roster");
                },
            },
            ownerEmail: async () => OWNER,
            entry: () => undefined,
        });
        await expect(chain(undefined, { people: ["bob@example.com"] })).resolves.toEqual({
            kind: "unreadable",
            who: ["bob@example.com"],
            detail: "members.json is not a roster",
        });
    });
});
