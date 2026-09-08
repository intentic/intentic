import { describe, expect, it } from "vitest";

// No mocks: laneDrop reads the lane machine from agentStatus, a pure leaf; the fleet store import is type-only and
// erased.
import { dropActionFor, dropActionLabel, dropRejection, type DropAction } from "./laneDrop";
import type { FleetAgent } from "../fleet/useAgents-fleet";

// A drop can't assign a status; it runs the action that causes one. Most drops have no action behind them at all.
describe("dropActionFor", () => {
    const none = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
    const agent = (over: Partial<FleetAgent>): FleetAgent => ({
        id: `a1`,
        status: `idle`,
        provider: `claude`,
        harness: `claude-code`,
        branch: `agent/a1`,
        updatedAt: 1,
        attention: none,
        open: false,
        unread: false,
        unsent: false,
        ...over,
    });
    // One armed watch as the roster carries it; only its presence matters to any rule here.
    const watch = { id: `watch-1`, note: `CI run 316`, intervalSeconds: 60, deadlineAt: 2 };

    it("stops a running turn dropped on finished", () => {
        expect(dropActionFor(agent({ status: `running` }), `finished`)).toBe(`stop`);
    });

    // The land it would ask for is the one already under way; the daemon refuses a second, and discarding would delete
    // the worktree being read.
    it("offers nothing for a card whose work is landing, and says why", () => {
        expect(dropActionFor(agent({ status: `landing` }), `finished`)).toBeUndefined();
        expect(dropActionFor(agent({ status: `landing` }), `discard`)).toBeUndefined();
        expect(dropRejection(agent({ status: `landing` }), `finished`)).toBe(`Its work is landing right now`);
        expect(dropRejection(agent({ status: `landing` }), `discard`)).toBe(`Its work is landing right now`);
    });

    // An errored turn never reached its auto-land, so the drop is a first attempt; a conflicted one already had its
    // land refused, and check mode is atomic so retrying is a guaranteed no-op.
    it("lands work whose turn errored out before it could land", () => {
        expect(dropActionFor(agent({ status: `error` }), `finished`)).toBe(`land`);
    });

    // Same shape, different cause: the daemon died under it, so its auto-land never ran and the worktree holds whatever
    // it got to.
    it("lands work whose turn was cut off by the daemon dying", () => {
        expect(dropActionFor(agent({ status: `interrupted` }), `finished`)).toBe(`land`);
    });

    // The auto-land is skipped for a user-stopped turn precisely so half-finished work doesn't land itself; this drop
    // is how the user says "keep it" instead.
    it("lands work whose turn the user stopped", () => {
        expect(dropActionFor(agent({ status: `stopped` }), `finished`)).toBe(`land`);
    });

    // A turn already ending by the user's hand has nothing to offer: the stop it would send has been sent, and the
    // worktree is the live unwind's until it finishes.
    it("offers nothing for a turn the user has already ended, either way of ending it", () => {
        for (const status of [`stopping`, `dismissing`] as const) {
            expect(dropActionFor(agent({ status }), `finished`)).toBeUndefined();
            expect(dropActionFor(agent({ status }), `discard`)).toBeUndefined();
            expect(dropRejection(agent({ status }), `finished`)).toContain(`ending`);
            expect(dropRejection(agent({ status }), `discard`)).toContain(`ending`);
        }
    });

    it("hands a conflict back to the agent instead of re-running the land that just refused", () => {
        expect(dropActionFor(agent({ status: `conflict` }), `finished`)).toBe(`resolve`);
        expect(dropActionFor(agent({ status: `idle`, attention: { ...none, conflict: true } }), `finished`)).toBe(`resolve`);
    });

    it("refuses to land an agent that is blocked on the user: it is mid-task, not done", () => {
        expect(dropActionFor(agent({ status: `awaiting` }), `finished`)).toBeUndefined();
        expect(dropActionFor(agent({ status: `idle`, attention: { ...none, plan: true } }), `finished`)).toBeUndefined();
        expect(dropActionFor(agent({ status: `idle`, attention: { ...none, question: true } }), `finished`)).toBeUndefined();
    });

    it("refuses the attention and active lanes outright: neither is something a user can assign", () => {
        for (const status of [`running`, `awaiting`, `conflict`, `error`, `idle`, `landed`] as const) {
            expect(dropActionFor(agent({ status }), `attention`)).toBeUndefined();
            expect(dropActionFor(agent({ status }), `active`)).toBeUndefined();
        }
    });

    it("refuses a card dropped on the lane it already sits in", () => {
        expect(dropActionFor(agent({ status: `landed` }), `finished`)).toBeUndefined();
        expect(dropActionFor(agent({ status: `idle` }), `finished`)).toBeUndefined();
    });

    // An armed watch is what keeps the card out of Finished, so disarming it is the drop's action, exactly as a running
    // turn's drop invokes the stop that ends it.
    it("stops the watches of a card dropped on finished", () => {
        expect(dropActionFor(agent({ status: `idle`, watches: [watch] }), `finished`)).toBe(`unwatch`);
    });

    // A watch is a timer, not a worktree: a workspace conversation arms one as readily and has no land, resolve or
    // discard to refuse.
    it("stops the watches of a workspace conversation too, which has no branch to act on", () => {
        expect(dropActionFor(agent({ status: `idle`, branch: undefined, watches: [watch] }), `finished`)).toBe(`unwatch`);
    });

    // Something more pressing outranks a watch on any blocked card; a watch never speaks over an unanswered question or
    // a refused land.
    it("yields to whatever else the card is blocked on", () => {
        expect(dropActionFor(agent({ status: `error`, watches: [watch] }), `finished`)).toBe(`land`);
        expect(dropActionFor(agent({ status: `conflict`, watches: [watch] }), `finished`)).toBe(`resolve`);
        expect(dropActionFor(agent({ status: `idle`, attention: { ...none, question: true }, watches: [watch] }), `finished`)).toBeUndefined();
    });

    // A running turn still outranks the watch: the stop is what that drop has always meant, and the watch stays armed
    // underneath it.
    it("yields to a live turn, whose drop is still the stop or a refusal", () => {
        expect(dropActionFor(agent({ status: `running`, watches: [watch] }), `finished`)).toBe(`stop`);
        expect(dropActionFor(agent({ status: `resuming`, watches: [watch] }), `finished`)).toBeUndefined();
        expect(dropRejection(agent({ status: `resuming`, watches: [watch] }), `finished`)).toContain(`picking itself back up`);
    });

    it("discards anything that isn't running, the daemon refuses a running turn's worktree", () => {
        expect(dropActionFor(agent({ status: `idle` }), `discard`)).toBe(`discard`);
        expect(dropActionFor(agent({ status: `awaiting` }), `discard`)).toBe(`discard`);
        expect(dropActionFor(agent({ status: `running` }), `discard`)).toBeUndefined();
    });

    // Both client-only standings refuse for one reason: the daemon has no entry for either, so every action addresses
    // an id it has never heard of.
    it("refuses every target for a draft and a refused send: no registry entry, no worktree, no turn", () => {
        for (const status of [`draft`, `failed`] as const) {
            for (const target of [`attention`, `active`, `finished`, `discard`] as const) {
                expect(dropActionFor(agent({ status }), target)).toBeUndefined();
            }
        }
    });

    it("refuses branch actions for workspace conversations, regardless of their lifecycle state", () => {
        for (const status of [`idle`, `awaiting`, `error`, `interrupted`, `conflict`, `landed`] as const) {
            const workspace = agent({ status, branch: undefined });
            expect(dropActionFor(workspace, `finished`)).toBeUndefined();
            expect(dropActionFor(workspace, `discard`)).toBeUndefined();
        }
    });

    // A refusal must always carry a hint, and an accepted drop must never carry one: it is the only thing that teaches
    // the board's rules.
    it("explains exactly the refusals it makes, and only those", () => {
        const cases: readonly FleetAgent[] = [
            agent({ status: `draft` }),
            agent({ status: `failed` }),
            agent({ status: `running` }),
            agent({ status: `awaiting` }),
            agent({ status: `conflict` }),
            agent({ status: `error` }),
            agent({ status: `interrupted` }),
            agent({ status: `stopping` }),
            agent({ status: `stopped` }),
            agent({ status: `landed` }),
            agent({ status: `idle` }),
            agent({ status: `idle`, attention: { ...none, plan: true } }),
            agent({ status: `idle`, attention: { ...none, conflict: true } }),
            agent({ status: `idle`, watches: [watch] }),
            agent({ status: `idle`, branch: undefined, watches: [watch] }),
            agent({ status: `idle`, attention: { ...none, question: true }, watches: [watch] }),
        ];
        for (const card of cases) {
            for (const target of [`attention`, `active`, `finished`, `discard`] as const) {
                const refused = dropActionFor(card, target) === undefined;
                expect(dropRejection(card, target) !== undefined).toBe(refused);
            }
        }
    });

    // An action with no verb of its own would silently borrow another's, which is how "Discard this agent" became the
    // fallback for anything unnamed.
    it("names every action it can return", () => {
        const labels = ([`land`, `resolve`, `stop`, `discard`, `unwatch`] as const satisfies readonly DropAction[]).map(dropActionLabel);
        expect(labels).toEqual([`Land the work`, `Ask the agent to resolve it`, `Stop the turn`, `Discard this agent`, `Stop watching`]);
        expect(new Set(labels).size).toBe(labels.length);
    });
});

// Three of the five actions are calls addressed by agent id and cross sandboxes intact; the two that aren't need
// something this browser holds for one daemon at a time, and the refusal must say so.
describe("a card whose agent is in another sandbox", () => {
    const none = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
    const elsewhere = (over: Partial<FleetAgent>): FleetAgent => ({
        id: `a1`,
        status: `idle`,
        provider: `claude`,
        harness: `claude-code`,
        branch: `agent/a1`,
        updatedAt: 1,
        attention: none,
        open: false,
        unread: false,
        unsent: false,
        sandboxId: `sbx-other`,
        ...over,
    });
    const watch = { id: `watch-1`, note: `CI run 316`, intervalSeconds: 60, deadlineAt: 2 };

    it("still stops its running turn: a cancel is addressed by id", () => {
        expect(dropActionFor(elsewhere({ status: `running` }), `finished`)).toBe(`stop`);
    });

    it("still lands an errored turn's work into the workspace it belongs to", () => {
        expect(dropActionFor(elsewhere({ status: `error` }), `finished`)).toBe(`land`);
    });

    it("still discards it: the worktree is the other daemon's to tear down", () => {
        expect(dropActionFor(elsewhere({}), `discard`)).toBe(`discard`);
    });

    // Asking the agent to rebase sends a turn, which needs the conversation the chat singleton holds for the active
    // daemon alone.
    it("refuses to ask the agent to resolve, and says the sandbox is why", () => {
        const conflicted = elsewhere({ status: `conflict`, attention: { ...none, conflict: true } });
        expect(dropActionFor({ ...conflicted, sandboxId: undefined }, `finished`)).toBe(`resolve`);
        expect(dropActionFor(conflicted, `finished`)).toBeUndefined();
        expect(dropRejection(conflicted, `finished`)).toContain(`sandbox`);
        expect(dropRejection(conflicted, `finished`)).not.toEqual(dropRejection(elsewhere({ status: `idle` }), `active`));
    });

    // Ending a watch writes through the fleet store, which is the active daemon's roster and has no entry for this
    // agent.
    it("refuses to end a watch, and says the sandbox is why", () => {
        const watching = elsewhere({ status: `idle`, watches: [watch] });
        const conflicted = elsewhere({ status: `conflict`, attention: { ...none, conflict: true } });
        expect(dropActionFor({ ...watching, sandboxId: undefined }, `finished`)).toBe(`unwatch`);
        expect(dropActionFor(watching, `finished`)).toBeUndefined();
        expect(dropRejection(watching, `finished`)).toContain(`sandbox`);
        expect(dropRejection(watching, `finished`)).not.toEqual(dropRejection(conflicted, `finished`));
    });

    // The box is only ever the reason when the drop would otherwise have worked; a card with nothing to offer keeps its
    // ordinary refusal.
    it("keeps the ordinary refusal when the box was never the obstacle", () => {
        expect(dropRejection(elsewhere({ status: `idle` }), `active`)).toContain(`message`);
    });
});
