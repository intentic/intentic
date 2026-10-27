import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { Service } from "@intentic/sandbox-contract/schemas/services";
import type { Member } from "../auth/auth.js";
import { type ChainEntry, createPrincipalChain, orgLimit, personLimit, principalsOf, serviceLimits } from "./principal-chain.js";

// Who a conversation acts for, turned into limits: a person's row, a service's steward and profile, an organisation's
// ceiling. Anything that cannot be named limits to nothing, never to everything.

const OWNER = "ada@example.com";
const NOTHING = { credentials: { capabilities: [], secrets: [] }, aiAccounts: [], tools: undefined };

const roster: Member[] = [
    { email: "bob@example.com", role: "collaborator", credentials: { capabilities: ["github"], secrets: [] }, aiAccounts: ["claude:work"], tools: { shell: false } },
    { email: "eve@example.com", role: "maintainer" },
    { email: "fox@example.com", role: "maintainer", credentials: { capabilities: ["github"], secrets: [] }, aiAccounts: ["claude:work"] },
];

const profiles: AccessProfile[] = [{ id: "marketing", credentials: { capabilities: ["reddit-work"], secrets: [] }, aiAccounts: ["claude"], tools: { browser: false } }];

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
    const chainWith = (over: { readonly org?: { readonly orgName: string; readonly ceiling?: { readonly tools?: { readonly shell?: boolean } } } } = {}) =>
        createPrincipalChain({
            members: { list: async () => roster },
            ownerEmail: async () => OWNER,
            entry: () => undefined,
            services: { list: async () => services },
            profiles: { list: async () => profiles },
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
