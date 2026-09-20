import { describe, expect, test } from "vitest";
import type { ProvenCaller } from "./auth.js";
import { deskEvent, heldPersonas, refuseUnlessHeld, refuseUnlessVisible, visibleTo } from "./desk-scope.js";

// The desk's fence over the fleet, as pure rules: whose conversation counts as theirs, which card they may wear, and
// which frames of the event stream reach them. The routes apply these; this pins what they apply.

const desk: ProvenCaller = { email: "Dee@Example.com", role: "desk", desks: ["support"], methods: ["google"] };
const viewer: ProvenCaller = { email: "vic@example.com", role: "viewer", methods: ["google"] };

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

    test("the refusal is FORBIDDEN and names nobody", () => {
        expect(() => refuseUnlessVisible(desk, { owner: { email: "ada@example.com" } })).toThrow(/not one of your conversations/);
        expect(() => refuseUnlessVisible(desk, { owner: { email: "dee@example.com" } })).not.toThrow();
    });
});

describe("refuseUnlessHeld", () => {
    test("a desk must name a card it holds; naming none is refused like naming another's", () => {
        expect(() => refuseUnlessHeld(desk, "support")).not.toThrow();
        expect(() => refuseUnlessHeld(desk, "sales")).toThrow(/"sales" is not one of your personas: support/);
        expect(() => refuseUnlessHeld(desk, undefined)).toThrow(/speaks through one of its personas: support/);
    });

    test("other tiers may name any card or none", () => {
        expect(() => refuseUnlessHeld(viewer, undefined)).not.toThrow();
        expect(() => refuseUnlessHeld(undefined, "sales")).not.toThrow();
    });

    test("heldPersonas answers only for a desk", () => {
        expect([...(heldPersonas(desk) ?? [])]).toEqual(["support"]);
        expect(heldPersonas(viewer)).toBeUndefined();
        expect(heldPersonas(undefined)).toBeUndefined();
    });
});

describe("deskEvent", () => {
    const mine = { id: "c1", owner: { email: "dee@example.com" } };
    const theirs = { id: "c2", owner: { email: "ada@example.com" } };

    test("the roster frame keeps only the desk's own conversations", () => {
        const framed = deskEvent(desk, { kind: "agents", agents: [mine, theirs] as never, rev: 3 });
        expect(framed).toEqual({ kind: "agents", agents: [mine], rev: 3 });
    });

    test("frames naming paths or repositories are dropped for a desk, kept for everyone else", () => {
        const changed = { kind: "workspaceChanged" as const, paths: ["docs/pricing.md"] };
        expect(deskEvent(desk, changed)).toBeUndefined();
        expect(deskEvent(desk, { kind: "reposChanged", repos: ["api"] })).toBeUndefined();
        expect(deskEvent(desk, { kind: "refsChanged", repos: ["api"] })).toBeUndefined();
        expect(deskEvent(viewer, changed)).toBe(changed);
        expect(deskEvent(undefined, changed)).toBe(changed);
    });

    test("heartbeats and presence ride through untouched", () => {
        const beat = { kind: "heartbeat" as const, rev: 1 };
        expect(deskEvent(desk, beat)).toBe(beat);
    });
});
