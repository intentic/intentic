import { describe, expect, test } from "vitest";
import type { ProvenCaller } from "./auth.js";
import { framedEvent, refuseUnlessVisible, visibleTo } from "./fleet-scope.js";

// The two fences over the fleet, as pure rules: whose conversation counts as a desk's, what a fenced member may see
// of work that is not theirs, and which frames of the event stream reach either. The routes apply these; this pins
// what they apply. Which persona cards that fence hands over is personas/persona-reach.test.ts, since answering it
// costs a manifest read.

// Unfenced on purpose, so the ownership narrowing is pinned on its own; the two are independent rules. The roster
// refuses an unfenced desk (auth.ts MemberSchema), and `fencedDesk` below is the shape that actually exists.
const desk: ProvenCaller = { email: "Dee@Example.com", role: "desk", methods: ["google"] };
const viewer: ProvenCaller = { email: "vic@example.com", role: "viewer", methods: ["google"] };
// Fenced to one area; the fence rides on the row whatever the tier, so a collaborator carries one too.
const fenced: ProvenCaller = { email: "fay@example.com", role: "collaborator", areas: ["support"], methods: ["google"] };

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
    test("a fenced member sees work behind their own areas, whoever started it", () => {
        expect(visibleTo(fenced, { owner: { email: "ada@example.com" }, areas: ["support"] })).toBe(true);
        expect(visibleTo(fenced, { owner: { email: "ada@example.com" }, areas: ["finance"] })).toBe(false);
        // Started by someone unfenced: it could have read anything, so it is not theirs to read back.
        expect(visibleTo(fenced, { owner: { email: "ada@example.com" } })).toBe(false);
        // Their own conversation is no exception; it is visible because its areas are theirs.
        expect(visibleTo(fenced, { owner: { email: "fay@example.com" } })).toBe(false);
    });

    test("both narrowings apply at once to a fenced desk", () => {
        const fencedDesk: ProvenCaller = { ...desk, areas: ["support"] };
        expect(visibleTo(fencedDesk, { owner: { email: "dee@example.com" }, areas: ["support"] })).toBe(true);
        // Theirs, but born wider than they hold.
        expect(visibleTo(fencedDesk, { owner: { email: "dee@example.com" }, areas: ["support", "finance"] })).toBe(false);
        // Within their areas, but somebody else's.
        expect(visibleTo(fencedDesk, { owner: { email: "ada@example.com" }, areas: ["support"] })).toBe(false);
    });

    test("the refusal is FORBIDDEN and names nobody", () => {
        expect(() => refuseUnlessVisible(desk, { owner: { email: "ada@example.com" } })).toThrow(/not one of your conversations/);
        expect(() => refuseUnlessVisible(desk, { owner: { email: "dee@example.com" } })).not.toThrow();
    });
});

describe("framedEvent", () => {
    const mine = { id: "c1", owner: { email: "dee@example.com" } };
    const theirs = { id: "c2", owner: { email: "ada@example.com" } };

    test("the roster frame keeps only the desk's own conversations", () => {
        const framed = framedEvent(desk, undefined, { kind: "agents", agents: [mine, theirs] as never, rev: 3 });
        expect(framed).toEqual({ kind: "agents", agents: [mine], rev: 3 });
    });

    // A desk is fenced like anyone else and reads its own area, so its frames are cut to that fence rather than
    // dropped: dropping them would leave the tree it can open stale behind it.
    test("frames naming paths or repositories are cut to the fence, and kept whole for an unfenced tier", () => {
        const changed = { kind: "workspaceChanged" as const, paths: ["docs/pricing.md"] };
        expect(framedEvent(desk, ["support"], changed)).toBeUndefined();
        expect(framedEvent(desk, ["support"], { kind: "reposChanged", repos: ["api"] })).toEqual({ kind: "reposChanged", repos: [] });
        expect(framedEvent(desk, ["support"], { kind: "workspaceChanged", paths: ["support/a.md"] })).toEqual({
            kind: "workspaceChanged",
            paths: ["support/a.md"],
        });
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
