import type { Member } from "../auth/auth.js";
import {
    createConversationAccountReach,
    createConversationCeiling,
    createConversationReach,
    accountReachAllows,
    outOfReachNote,
    peopleOf,
    REACH_ALL,
    reachAllows,
    reachCliEnv,
    reachOfPeople,
    withinReach,
} from "./credential-reach.js";

// What a conversation may spend is what every person it works for may: the owner everything, anyone on the roster (a
// maintainer included) their row's reach (absent: everything), anyone the roster no longer names nothing. Read off the conversation's latched
// people and its parents', so a child or a peer message never spends more than the person behind it.

const OWNER = "ada@example.com";
const roster: Member[] = [
    { email: "bob@example.com", role: "collaborator", credentials: { capabilities: ["github", "reddit"], secrets: ["DATABASE_URL"] } },
    { email: "cy@example.com", role: "collaborator", credentials: { capabilities: ["github"], secrets: [] } },
    { email: "dee@example.com", role: "collaborator" },
    { email: "eve@example.com", role: "maintainer" },
    // Managing the sandbox and spending all of it are separate answers: a maintainer may be held to some of it.
    { email: "fox@example.com", role: "maintainer", credentials: { capabilities: ["github"], secrets: [] } },
];

test("the owner, and a maintainer or a member with no reach on their row, are not limited", () => {
    expect(reachOfPeople([OWNER], roster, OWNER)).toEqual(REACH_ALL);
    expect(reachOfPeople(["eve@example.com", "dee@example.com"], roster, OWNER)).toEqual(REACH_ALL);
});

test("a maintainer with a reach on their row spends only that", () => {
    const reach = reachOfPeople(["fox@example.com"], roster, OWNER);
    expect(reachAllows(reach, "capability", "github")).toBe(true);
    expect(reachAllows(reach, "capability", "reddit")).toBe(false);
    expect(reach).toMatchObject({ kind: "some", who: ["fox@example.com"] });
});

test("a conversation reaches only what every person in it may, whatever the case of their address", () => {
    const reach = reachOfPeople(["Bob@Example.com", OWNER, "cy@example.com"], roster, OWNER);
    expect(reachAllows(reach, "capability", "github")).toBe(true);
    expect(reachAllows(reach, "capability", "reddit")).toBe(false);
    expect(reachAllows(reach, "secret", "DATABASE_URL")).toBe(false);
    expect(reach).toMatchObject({ kind: "some", who: ["bob@example.com", "cy@example.com"] });
});

test("somebody the roster no longer names reaches nothing, rather than what the owner does", () => {
    const reach = reachOfPeople(["gone@example.com"], roster, OWNER);
    expect(reachAllows(reach, "capability", "github")).toBe(false);
    expect(reachAllows(reach, "secret", "DATABASE_URL")).toBe(false);
});

test("a reach decides only the kinds that hold something a turn can be denied", () => {
    const reach = reachOfPeople(["cy@example.com"], roster, OWNER);
    const { kept, withheld } = withinReach(
        [
            { id: "github", kind: "cli" as const },
            { id: "reddit", kind: "browser" as const },
            { id: "laptop", kind: "device" as const },
            { id: "docker", kind: "docker" as const },
        ],
        reach,
    );
    expect(kept.map((capability) => capability.id)).toEqual(["github", "docker"]);
    expect(withheld.map((capability) => capability.id)).toEqual(["reddit", "laptop"]);
});

test("a withheld connector loses every variable carrying its suffix, its gateway address included", () => {
    const env = { GITHUB_TOKEN_GITHUB: "held", CREDENTIAL_GATEWAY_GITHUB: "http://gw", FLY_API_TOKEN_FLY: "x", PATH: "/bin" };
    const kept = reachCliEnv(env, [{ id: "github", kind: "cli" }], (id) => id.toUpperCase());
    expect(kept).toEqual({ FLY_API_TOKEN_FLY: "x", PATH: "/bin" });
});

// The parts of a record peopleOf reads.
const entries = new Map([
    ["parent", { identity: { people: ["bob@example.com"], startedBy: "bob@example.com" }, social: {} }],
    ["child", { identity: { people: [OWNER], startedBy: "agent:parent" }, social: {} }],
    ["grandchild", { identity: { startedBy: "agent:child" }, social: {} }],
    // A row from before `people` names the member it belongs to.
    ["old", { identity: { startedBy: "cy@example.com" }, social: { owner: { email: "cy@example.com" } } }],
    ["loop", { identity: { people: ["dee@example.com"], startedBy: "agent:loop" }, social: {} }],
]);
const entryOf = (id: string) => entries.get(id);

test("a conversation works for its own people and every conversation above it, read live", () => {
    expect(peopleOf(entryOf, "grandchild").toSorted()).toEqual([OWNER, "bob@example.com"]);
    expect(peopleOf(entryOf, "old")).toEqual(["cy@example.com"]);
    expect(peopleOf(entryOf, "loop")).toEqual(["dee@example.com"]);
    expect(peopleOf(entryOf, undefined)).toEqual([]);
});

const reachFor = (over: { roster?: () => Promise<readonly Member[]> } = {}) =>
    createConversationReach({
        members: { list: over.roster ?? (async () => roster) },
        ownerEmail: async () => OWNER,
        entry: entryOf,
    });

test("a child spends only what the person behind its parent may", async () => {
    const reach = await reachFor()("child");
    expect(reachAllows(reach, "capability", "reddit")).toBe(true);
    expect(reachAllows(reach, "capability", "fly")).toBe(false);
});

test("a person whose turn is starting counts before the conversation records them", async () => {
    expect(await reachFor()(undefined)).toEqual(REACH_ALL);
    expect(reachAllows(await reachFor()(undefined, ["cy@example.com"]), "capability", "reddit")).toBe(false);
});

test("the owner alone never reads the roster, and a roster that cannot be read reaches nothing", async () => {
    const unreadable = reachFor({
        roster: async () => {
            throw new Error("members.json is not a roster");
        },
    });
    expect(await unreadable(undefined, [OWNER])).toEqual(REACH_ALL);
    const reach = await unreadable("parent");
    expect(reachAllows(reach, "capability", "github")).toBe(false);
    expect(reach).toMatchObject({ kind: "some", unreadable: "members.json is not a roster" });
});

test("the model is told what is left out and that nobody can be asked for it, only when something is", () => {
    expect(outOfReachNote(REACH_ALL, [])).toBeUndefined();
    const note = outOfReachNote(reachOfPeople(["cy@example.com"], roster, OWNER), [{ id: "reddit" }]);
    expect(note?.text).toContain("`reddit`");
    expect(note?.text).toContain("cy@example.com");
    expect(note?.text).toContain("do not raise `secrets request`");
});

// A service acts for its steward, held to its profile: a turn running as one spends what both allow, on AI accounts both
// allow, with tools under its profile's ceiling; one whose steward left spends nothing.
describe("a conversation running as a service", () => {
    const deps = {
        members: { list: async () => roster },
        ownerEmail: async () => OWNER,
        entry: () => undefined,
        services: {
            list: async () => [
                { id: "bot", steward: OWNER, profile: "posting" },
                { id: "bobs", steward: "bob@example.com", profile: "posting" },
                { id: "orphan", steward: "gone@example.com" },
            ],
        },
        profiles: { list: async () => [{ id: "posting", credentials: { capabilities: ["reddit"], secrets: [] }, aiAccounts: ["claude:work"], tools: { shell: false } }] },
    };

    test("spends what its steward and its profile both allow", async () => {
        const reach = await createConversationReach(deps)(undefined, [], ["bobs"]);
        expect(reachAllows(reach, "capability", "reddit")).toBe(true);
        expect(reachAllows(reach, "capability", "github")).toBe(false);
        expect(reachAllows(reach, "secret", "DATABASE_URL")).toBe(false);
        const owners = await createConversationReach(deps)(undefined, [], ["bot"]);
        expect(reachAllows(owners, "capability", "reddit")).toBe(true);
        expect(reachAllows(owners, "capability", "fly")).toBe(false);
    });

    test("runs only on AI accounts its profile allows, and under its tool ceiling", async () => {
        const accounts = await createConversationAccountReach(deps)(undefined, [], ["bot"]);
        expect(accountReachAllows(accounts, "claude", "work")).toBe(true);
        expect(accountReachAllows(accounts, "claude", "personal")).toBe(false);
        await expect(createConversationCeiling(deps)(undefined, [], ["bot"])).resolves.toEqual({ shell: false });
        await expect(createConversationCeiling(deps)(undefined, [OWNER])).resolves.toBeUndefined();
    });

    test("spends nothing once its steward has left", async () => {
        const reach = await createConversationReach(deps)(undefined, [], ["orphan"]);
        expect(reachAllows(reach, "capability", "github")).toBe(false);
        expect(reach).toMatchObject({ kind: "some", who: [`the service "orphan" (for gone@example.com)`] });
    });
});

// An account a person connected is always theirs to run on, even where their row lists only some; it widens only that
// person's own row, never a service run for them, nor anyone the roster no longer names.
describe("the AI accounts a person connected themselves", () => {
    const limited: Member[] = [
        { email: "bob@example.com", role: "collaborator", aiAccounts: ["claude:a"] },
        { email: "cy@example.com", role: "collaborator", aiAccounts: ["claude:a"] },
    ];
    const connectors = {
        all: async () =>
            new Map([
                ["claude:b", "bob@example.com"],
                ["claude:c", "gone@example.com"],
            ]),
    };
    const deps = {
        members: { list: async () => limited },
        ownerEmail: async () => OWNER,
        entry: () => undefined,
        connectors,
        services: { list: async () => [{ id: "bobs", steward: "bob@example.com" }] },
    };

    test("are theirs to run on beside their row's, and still held to everyone else's in the conversation", async () => {
        const reach = await createConversationAccountReach(deps)(undefined, ["Bob@Example.com"]);
        expect(accountReachAllows(reach, "claude", "a")).toBe(true);
        expect(accountReachAllows(reach, "claude", "b")).toBe(true);
        expect(accountReachAllows(reach, "claude", "c")).toBe(false);
        const shared = await createConversationAccountReach(deps)(undefined, ["bob@example.com", "cy@example.com"]);
        expect(accountReachAllows(shared, "claude", "a")).toBe(true);
        expect(accountReachAllows(shared, "claude", "b")).toBe(false);
    });

    test("widen neither someone the roster no longer names nor a service run for the person", async () => {
        const gone = await createConversationAccountReach(deps)(undefined, ["gone@example.com"]);
        expect(accountReachAllows(gone, "claude", "c")).toBe(false);
        const service = await createConversationAccountReach(deps)(undefined, [], ["bobs"]);
        expect(accountReachAllows(service, "claude", "a")).toBe(true);
        expect(accountReachAllows(service, "claude", "b")).toBe(false);
    });

    test("leave each row's own list when the record cannot be read", async () => {
        const unreadable = {
            all: async (): Promise<never> => {
                throw new Error("history volume unreadable");
            },
        };
        const reach = await createConversationAccountReach({ ...deps, connectors: unreadable })(undefined, ["bob@example.com"]);
        expect(reach).toMatchObject({ kind: "some", who: ["bob@example.com"] });
        expect(accountReachAllows(reach, "claude", "a")).toBe(true);
        expect(accountReachAllows(reach, "claude", "b")).toBe(false);
    });
});
