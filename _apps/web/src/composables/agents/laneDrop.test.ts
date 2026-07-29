import { describe, expect, it } from "vitest";

// No mocks. laneDrop reads the lane machine from agentStatus — a leaf of pure functions — and its only tie to
// the fleet store is a type-only import, which the transform erases. Nothing here reaches the app shell.
import { dropActionFor, dropActionLabel, dropRejection, type DropAction } from "./laneDrop";
import type { FleetAgent } from "./useAgents";

// A drop can't assign a status — the lanes are projections — so it runs the action that CAUSES one, and most
// drops have no action behind them at all.
describe("dropActionFor", () => {
    const none = { plan: false, question: false, permission: false, conflict: false };
    const agent = (over: Partial<FleetAgent>): FleetAgent => ({
        id: `a1`,
        status: `idle`,
        provider: `claude`,
        harness: `claude-code`,
        updatedAt: 1,
        attention: none,
        open: false,
        unread: false,
        ...over,
    });

    it("stops a running turn dropped on finished", () => {
        expect(dropActionFor(agent({ status: `running` }), `finished`)).toBe(`stop`);
    });

    // An errored turn never reached its auto-land, so the drop has a FIRST land to try. A conflicted one has
    // already had that land refused, and check mode is atomic — pressing it again against an unchanged
    // workspace fails identically, which is what made this drop a guaranteed no-op.
    it("lands work whose turn errored out before it could land", () => {
        expect(dropActionFor(agent({ status: `error` }), `finished`)).toBe(`land`);
    });

    // Same shape, different cause: the daemon died under this one, so its auto-land never ran either and its
    // worktree still holds however far it got.
    it("lands work whose turn was cut off by the daemon dying", () => {
        expect(dropActionFor(agent({ status: `interrupted` }), `finished`)).toBe(`land`);
    });

    it("hands a conflict back to the agent instead of re-running the land that just refused", () => {
        expect(dropActionFor(agent({ status: `conflict` }), `finished`)).toBe(`resolve`);
        expect(dropActionFor(agent({ status: `idle`, attention: { ...none, conflict: true } }), `finished`)).toBe(`resolve`);
    });

    it("refuses to land an agent that is blocked on the user — it is mid-task, not done", () => {
        expect(dropActionFor(agent({ status: `awaiting` }), `finished`)).toBeUndefined();
        expect(dropActionFor(agent({ status: `idle`, attention: { ...none, plan: true } }), `finished`)).toBeUndefined();
        expect(dropActionFor(agent({ status: `idle`, attention: { ...none, question: true } }), `finished`)).toBeUndefined();
    });

    it("refuses the attention and active lanes outright — neither is something a user can assign", () => {
        for (const status of [`running`, `awaiting`, `conflict`, `error`, `idle`, `landed`] as const) {
            expect(dropActionFor(agent({ status }), `attention`)).toBeUndefined();
            expect(dropActionFor(agent({ status }), `active`)).toBeUndefined();
        }
    });

    it("refuses a card dropped on the lane it already sits in", () => {
        expect(dropActionFor(agent({ status: `landed` }), `finished`)).toBeUndefined();
        expect(dropActionFor(agent({ status: `idle` }), `finished`)).toBeUndefined();
    });

    it("discards anything that isn't running — the daemon refuses a running turn's worktree", () => {
        expect(dropActionFor(agent({ status: `idle` }), `discard`)).toBe(`discard`);
        expect(dropActionFor(agent({ status: `awaiting` }), `discard`)).toBe(`discard`);
        expect(dropActionFor(agent({ status: `running` }), `discard`)).toBeUndefined();
    });

    it("refuses every target for a draft — no registry entry, no worktree, no turn", () => {
        for (const target of [`attention`, `active`, `finished`, `discard`] as const) {
            expect(dropActionFor(agent({ status: `draft` }), target)).toBeUndefined();
        }
    });

    // The hint is the only thing that teaches the board's rules, so a refusal must always carry one — and an
    // accepted drop must never carry one.
    it("explains exactly the refusals it makes, and only those", () => {
        const cases: readonly FleetAgent[] = [
            agent({ status: `draft` }),
            agent({ status: `running` }),
            agent({ status: `awaiting` }),
            agent({ status: `conflict` }),
            agent({ status: `error` }),
            agent({ status: `interrupted` }),
            agent({ status: `landed` }),
            agent({ status: `idle` }),
            agent({ status: `idle`, attention: { ...none, plan: true } }),
            agent({ status: `idle`, attention: { ...none, conflict: true } }),
        ];
        for (const card of cases) {
            for (const target of [`attention`, `active`, `finished`, `discard`] as const) {
                const refused = dropActionFor(card, target) === undefined;
                expect(dropRejection(card, target) !== undefined).toBe(refused);
            }
        }
    });

    // The hint is the ghost's whole promise, so an action with no verb of its own would silently borrow
    // another's — which is how "Discard this agent" came to be the fallback for anything unnamed.
    it("names every action it can return", () => {
        const labels = ([`land`, `resolve`, `stop`, `discard`] as const satisfies readonly DropAction[]).map(dropActionLabel);
        expect(labels).toEqual([`Land the work`, `Ask the agent to resolve it`, `Stop the turn`, `Discard this agent`]);
        expect(new Set(labels).size).toBe(labels.length);
    });
});
