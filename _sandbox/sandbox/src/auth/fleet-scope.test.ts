import { describe, expect, test } from "vitest";
import type { ProvenCaller } from "./auth.js";
import { framedEvent, heldPersonas, refuseUnlessHeld, refuseUnlessVisible, visibleTo } from "./fleet-scope.js";

// The two fences over the fleet, as pure rules: whose conversation counts as a desk's, which persona a desk may wear,
// what a fenced member may see of work that is not theirs, and which frames of the event stream reach either. The
// routes apply these; this pins what they apply.

const desk: ProvenCaller = { email: "Dee@Example.com", role: "desk", desks: ["support"], methods: ["google"] };
const viewer: ProvenCaller = { email: "vic@example.com", role: "viewer", methods: ["google"] };
// Fenced to one slice; the fence rides on the row whatever the tier, so a collaborator carries one too.
const fenced: ProvenCaller = { email: "fay@example.com", role: "collaborator", slices: ["support"], methods: ["google"] };

describe("visibleTo", () => {
    test("a desk sees what it owns or started, compared folded; nothing else", () => {
        expect(visibleTo(desk, { owner: { email: "dee@example.com" } })).toBe(true);
        expect(visibleTo(desk, { startedBy: "dee@example.com" })).toBe(true);
        expect(visibleTo(desk, { owner: { email: "ada@example.com" }, startedBy: "ada@example.com" })).toBe(false);
        // A wake nobody owns is still not the desk's.
        expect(visibleTo(desk, {})).toBe(false);
    });

    test("every other tier, and the owner's own tools, see the fleet whole", () => {
        expect(visibleTo(viewer, { owner: { email: "ada@example.com" } })).toBe(true);
        expect(visibleTo(undefined, {})).toBe(true);
    });

    // Fencing the files and leaving the transcripts open would be a fence with a door in it: a conversation carries
    // whatever it read.
    test("a fenced member sees work behind their own slices, whoever started it", () => {
        expect(visibleTo(fenced, { owner: { email: "ada@example.com" }, slices: ["support"] })).toBe(true);
        expect(visibleTo(fenced, { owner: { email: "ada@example.com" }, slices: ["finance"] })).toBe(false);
        // Started by someone unfenced: it could have read anything, so it is not theirs to read back.
        expect(visibleTo(fenced, { owner: { email: "ada@example.com" } })).toBe(false);
        // Their own conversation is no exception; it is visible because its slices are theirs.
        expect(visibleTo(fenced, { owner: { email: "fay@example.com" } })).toBe(false);
    });

    test("both narrowings apply at once to a fenced desk", () => {
        const fencedDesk: ProvenCaller = { ...desk, slices: ["support"] };
        expect(visibleTo(fencedDesk, { owner: { email: "dee@example.com" }, slices: ["support"] })).toBe(true);
        // Theirs, but born wider than they hold.
        expect(visibleTo(fencedDesk, { owner: { email: "dee@example.com" }, slices: ["support", "finance"] })).toBe(false);
        // Within their slices, but somebody else's.
        expect(visibleTo(fencedDesk, { owner: { email: "ada@example.com" }, slices: ["support"] })).toBe(false);
    });

    test("the refusal is FORBIDDEN and names nobody", () => {
        expect(() => refuseUnlessVisible(desk, { owner: { email: "ada@example.com" } })).toThrow(/not one of your conversations/);
        expect(() => refuseUnlessVisible(desk, { owner: { email: "dee@example.com" } })).not.toThrow();
    });
});

describe("refuseUnlessHeld", () => {
    test("a desk must name a persona it holds; naming none is refused like naming another's", () => {
        expect(() => refuseUnlessHeld(desk, "support")).not.toThrow();
        expect(() => refuseUnlessHeld(desk, "sales")).toThrow(/"sales" is not one of your personas: support/);
        expect(() => refuseUnlessHeld(desk, undefined)).toThrow(/speaks through one of its personas: support/);
    });

    test("other tiers may name any persona or none", () => {
        expect(() => refuseUnlessHeld(viewer, undefined)).not.toThrow();
        expect(() => refuseUnlessHeld(undefined, "sales")).not.toThrow();
    });

    test("heldPersonas answers only for a desk", () => {
        expect([...(heldPersonas(desk) ?? [])]).toEqual(["support"]);
        expect(heldPersonas(viewer)).toBeUndefined();
        expect(heldPersonas(undefined)).toBeUndefined();
    });
});

describe("framedEvent", () => {
    const mine = { id: "c1", owner: { email: "dee@example.com" } };
    const theirs = { id: "c2", owner: { email: "ada@example.com" } };

    test("the roster frame keeps only the desk's own conversations", () => {
        const framed = framedEvent(desk, undefined, { kind: "agents", agents: [mine, theirs] as never, rev: 3 });
        expect(framed).toEqual({ kind: "agents", agents: [mine], rev: 3 });
    });

    test("frames naming paths or repositories are dropped for a desk, kept whole for an unfenced tier", () => {
        const changed = { kind: "workspaceChanged" as const, paths: ["docs/pricing.md"] };
        expect(framedEvent(desk, undefined, changed)).toBeUndefined();
        expect(framedEvent(desk, undefined, { kind: "reposChanged", repos: ["api"] })).toBeUndefined();
        expect(framedEvent(desk, undefined, { kind: "refsChanged", repos: ["api"] })).toBeUndefined();
        expect(framedEvent(viewer, undefined, changed)).toBe(changed);
        expect(framedEvent(undefined, undefined, changed)).toBe(changed);
    });

    test("a fenced member's path frames are cut to their own folders, and dropped when nothing is left", () => {
        const fence = ["support"];
        expect(framedEvent(fenced, fence, { kind: "workspaceChanged", paths: ["support/a.md", "finance/b.csv"] })).toEqual({
            kind: "workspaceChanged",
            paths: ["support/a.md"],
        });
        expect(framedEvent(fenced, fence, { kind: "workspaceChanged", paths: ["finance/b.csv"] })).toBeUndefined();
    });

    // An empty batch already means "refetch the whole tree", and that refetch is itself fenced.
    test("a refetch-everything frame rides through a fence untouched", () => {
        const all = { kind: "workspaceChanged" as const, paths: [] };
        expect(framedEvent(fenced, ["support"], all)).toBe(all);
    });

    test("repository frames keep the ones a fenced member holds, and the ones leading to them", () => {
        expect(framedEvent(fenced, ["support/tickets"], { kind: "refsChanged", repos: ["support", "finance"] })).toEqual({
            kind: "refsChanged",
            repos: ["support"],
        });
    });

    test("heartbeats and presence ride through untouched", () => {
        const beat = { kind: "heartbeat" as const, rev: 1 };
        expect(framedEvent(desk, undefined, beat)).toBe(beat);
    });
});
