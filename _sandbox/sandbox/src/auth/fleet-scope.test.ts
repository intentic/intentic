import type { ProvenCaller } from "./auth.js";
import type { SandboxMetrics } from "@intentic/sandbox-contract";
import { framedEvent, framedMetrics, type Provenance, refuseUnlessVisible, visibleTo } from "./fleet-scope.js";

// The two fences over the fleet, as pure rules: whose conversation counts as a guest's, what a fenced member may see
// of work that is not theirs, and which frames of the event stream reach either. The routes apply these; this pins
// what they apply. Which persona cards that fence hands over is personas/persona-reach.test.ts, since answering it
// costs a manifest read.

// Unfenced on purpose, so the ownership narrowing is pinned on its own; the two are independent rules. The roster
// refuses an unfenced guest (auth.ts MemberSchema), and `fencedGuest` below is the shape that actually exists.
const guest: ProvenCaller = { email: "Dee@Example.com", role: "guest", methods: ["google"] };
const viewer: ProvenCaller = { email: "vic@example.com", role: "viewer", methods: ["google"] };
// Fenced to one area; the fence rides on the row whatever the tier, so a collaborator carries one too.
const fenced: ProvenCaller = { email: "fay@example.com", role: "collaborator", areas: ["support"], methods: ["google"] };

describe("visibleTo", () => {
    test("a guest sees what it owns or started, compared folded; nothing else", () => {
        expect(visibleTo(guest, { owner: { email: "dee@example.com" } })).toBe(true);
        expect(visibleTo(guest, { startedBy: "dee@example.com" })).toBe(true);
        expect(visibleTo(guest, { owner: { email: "ada@example.com" }, startedBy: "ada@example.com" })).toBe(false);
        // A wake nobody owns is still not the guest's.
        expect(visibleTo(guest, {})).toBe(false);
    });

    test("every other tier, and the owner's own tools, see the fleet whole", () => {
        expect(visibleTo(viewer, { owner: { email: "ada@example.com" } })).toBe(true);
        expect(visibleTo(undefined, {})).toBe(true);
    });

    // Fencing the files and leaving the transcripts open would be a fence with a door in it: a conversation carries
    // whatever it read.
    test("a fenced member sees work behind their own areas, whoever started it", () => {
        expect(visibleTo(fenced, { owner: { email: "ada@example.com" }, areas: ["support"] })).toBe(true);
        expect(visibleTo(fenced, { owner: { email: "ada@example.com" }, areas: ["finance"] })).toBe(false);
        // Started by someone unfenced: it could have read anything, so it is not theirs to read back.
        expect(visibleTo(fenced, { owner: { email: "ada@example.com" } })).toBe(false);
        // Their own conversation is no exception; it is visible because its areas are theirs.
        expect(visibleTo(fenced, { owner: { email: "fay@example.com" } })).toBe(false);
    });

    test("both narrowings apply at once to a fenced guest", () => {
        const fencedGuest: ProvenCaller = { ...guest, areas: ["support"] };
        expect(visibleTo(fencedGuest, { owner: { email: "dee@example.com" }, areas: ["support"] })).toBe(true);
        // Theirs, but born wider than they hold.
        expect(visibleTo(fencedGuest, { owner: { email: "dee@example.com" }, areas: ["support", "finance"] })).toBe(false);
        // Within their areas, but somebody else's.
        expect(visibleTo(fencedGuest, { owner: { email: "ada@example.com" }, areas: ["support"] })).toBe(false);
    });

    test("the refusal is FORBIDDEN and names nobody", () => {
        expect(() => refuseUnlessVisible(guest, { owner: { email: "ada@example.com" } })).toThrow(/not one of your conversations/);
        expect(() => refuseUnlessVisible(guest, { owner: { email: "dee@example.com" } })).not.toThrow();
    });
});

// The registry as framedEvent reads it: which conversation an id is, if any.
const nowhere = (): Provenance | undefined => undefined;

describe("framedEvent", () => {
    const mine = { id: "c1", owner: { email: "dee@example.com" } };
    const theirs = { id: "c2", owner: { email: "ada@example.com" } };

    test("the roster frame keeps only the guest's own conversations", () => {
        const framed = framedEvent(guest, undefined, { kind: "agents", agents: [mine, theirs] as never, rev: 3 }, nowhere);
        expect(framed).toEqual({ kind: "agents", agents: [mine], rev: 3 } as never);
    });

    // A guest is fenced like anyone else and reads its own area, so its frames are cut to that fence rather than
    // dropped: dropping them would leave the tree it can open stale behind it.
    test("frames naming paths or repositories are cut to the fence, and kept whole for an unfenced tier", () => {
        const changed = { kind: "workspaceChanged" as const, paths: ["docs/pricing.md"] };
        expect(framedEvent(guest, ["support"], changed, nowhere)).toBeUndefined();
        expect(framedEvent(guest, ["support"], { kind: "reposChanged", repos: ["api"] }, nowhere)).toEqual({ kind: "reposChanged", repos: [] });
        expect(framedEvent(guest, ["support"], { kind: "workspaceChanged", paths: ["support/a.md"] }, nowhere)).toEqual({
            kind: "workspaceChanged",
            paths: ["support/a.md"],
        });
        expect(framedEvent(viewer, undefined, changed, nowhere)).toBe(changed);
        expect(framedEvent(undefined, undefined, changed, nowhere)).toBe(changed);
    });

    test("a fenced member's path frames are cut to their own folders, and dropped when nothing is left", () => {
        const fence = ["support"];
        expect(framedEvent(fenced, fence, { kind: "workspaceChanged", paths: ["support/a.md", "finance/b.csv"] }, nowhere)).toEqual({
            kind: "workspaceChanged",
            paths: ["support/a.md"],
        });
        expect(framedEvent(fenced, fence, { kind: "workspaceChanged", paths: ["finance/b.csv"] }, nowhere)).toBeUndefined();
    });

    // An empty batch already means "refetch the whole tree", and that refetch is itself fenced.
    test("a refetch-everything frame rides through a fence untouched", () => {
        const all = { kind: "workspaceChanged" as const, paths: [] };
        expect(framedEvent(fenced, ["support"], all, nowhere)).toBe(all);
    });

    test("repository frames keep the ones a fenced member holds, and the ones leading to them", () => {
        expect(framedEvent(fenced, ["support/tickets"], { kind: "refsChanged", repos: ["support", "finance"] }, nowhere)).toEqual({
            kind: "refsChanged",
            repos: ["support"],
        });
    });

    // The same cut the tree route makes: an admitted folder whole, one on the way down only toward what is admitted.
    test("tree changes keep what the fence admits and the way down to it, and nothing else", () => {
        const entry = (path: string) => ({ name: path.slice(path.lastIndexOf("/") + 1), path, type: "file" as const });
        const changed = {
            kind: "treeChanged" as const,
            from: 1,
            generation: 2,
            dirs: [
                { path: "", entries: [entry("finance"), entry("support"), entry("README.md")] },
                { path: "support/tickets", entries: [entry("support/tickets/a.md")] },
                { path: "finance", entries: [entry("finance/ledger.csv")] },
                { path: "support", entries: [entry("support/tickets"), entry("support/private")] },
            ],
            barren: ["finance/old", "support/tickets/empty"],
        };
        expect(framedEvent(fenced, ["support/tickets"], changed, nowhere)).toEqual({
            ...changed,
            dirs: [
                { path: "", entries: [entry("support")] },
                { path: "support/tickets", entries: [entry("support/tickets/a.md")] },
                { path: "support", entries: [entry("support/tickets")] },
            ],
            barren: ["support/tickets/empty"],
        });
        expect(framedEvent(viewer, undefined, changed, nowhere)).toBe(changed);
    });

    test("heartbeats ride through untouched", () => {
        const beat = { kind: "heartbeat" as const, rev: 1 };
        expect(framedEvent(guest, undefined, beat, nowhere)).toBe(beat);
    });

    // Who is online is shared; which file a tab has open and which conversation it shows are places, cut like the rest.
    test("presence keeps everyone online but only the places the reader may see", () => {
        const conversations: Record<string, Provenance> = {
            support: { owner: { email: "ada@example.com" }, areas: ["support"] },
            finance: { owner: { email: "ada@example.com" }, areas: ["finance"] },
            dees: { owner: { email: "dee@example.com" }, areas: ["support"] },
        };
        const agentOf = (id: string): Provenance | undefined => conversations[id];
        const tab = (path: string, sessionId: string) => ({
            clientId: `t-${sessionId}`,
            email: "ada@example.com",
            role: "owner" as const,
            idle: false,
            view: "workspace",
            path,
            sessionId,
        });
        const online = { clientId: "", email: "ada@example.com", role: "owner" as const, idle: false, view: "workspace" };
        const frame = { kind: "presence" as const, users: [tab("finance/ledger.csv", "finance"), tab("support/faq.md", "support"), tab("support/faq.md", "gone")] };

        expect(framedEvent(fenced, ["support"], frame, agentOf)).toEqual({
            kind: "presence",
            users: [
                { ...online, clientId: "t-finance" },
                { ...online, clientId: "t-support", path: "support/faq.md", sessionId: "support" },
                // A conversation the registry no longer knows is nobody's to point at.
                { ...online, clientId: "t-gone", path: "support/faq.md" },
            ],
        });
        // A guest is shown only its own conversations, even inside its fence.
        const guests = framedEvent({ ...guest, areas: ["support"] }, ["support"], { kind: "presence", users: [tab("support/a.md", "dees"), tab("support/b.md", "support")] }, agentOf);
        expect(guests).toEqual({
            kind: "presence",
            users: [
                { ...online, clientId: "t-dees", path: "support/a.md", sessionId: "dees" },
                { ...online, clientId: "t-support", path: "support/b.md" },
            ],
        });
        // The owner's own tools see every place.
        expect(framedEvent(undefined, undefined, frame, agentOf)).toBe(frame);
    });
});

describe("framedMetrics", () => {
    const metrics: SandboxMetrics = {
        at: 1,
        sandbox: { cores: 2, memoryBytes: 1, memoryLimitBytes: 2, loadAverage: [0, 0, 0], processes: 5 },
        daemon: { rssBytes: 1, heapUsedBytes: 1 },
        sessions: {
            mine: { processes: 1, rssBytes: 10 },
            theirs: { processes: 1, rssBytes: 20 },
            support: { processes: 1, rssBytes: 30 },
            // Stamped, but not a conversation this registry holds: another daemon's, or one already archived.
            stray: { processes: 1, rssBytes: 40 },
        },
        roles: { agentRuntime: { processes: 4, rssBytes: 100 } },
    };
    const registry: Record<string, Provenance> = {
        mine: { owner: { email: "dee@example.com" } },
        theirs: { owner: { email: "ada@example.com" } },
        support: { owner: { email: "ada@example.com" }, areas: ["support"] },
    };
    const agentOf = (id: string): Provenance | undefined => registry[id];

    test("a guest is told of its own conversations only; the sandbox-wide figures stay whole", () => {
        const framed = framedMetrics(guest, metrics, agentOf);
        expect(framed.sessions).toEqual({ mine: { processes: 1, rssBytes: 10 } });
        expect(framed.sandbox).toEqual(metrics.sandbox);
        expect(framed.roles).toEqual({ agentRuntime: { processes: 4, rssBytes: 100 } });
    });

    test("a fenced member is told of the work behind their own areas", () => {
        expect(Object.keys(framedMetrics(fenced, metrics, agentOf).sessions)).toEqual(["support"]);
    });

    test("a conversation the registry does not know is left out even for a caller who sees the fleet whole", () => {
        expect(Object.keys(framedMetrics(viewer, metrics, agentOf).sessions)).toEqual(["mine", "theirs", "support"]);
        expect(Object.keys(framedMetrics(undefined, metrics, agentOf).sessions)).toEqual(["mine", "theirs", "support"]);
    });
});
