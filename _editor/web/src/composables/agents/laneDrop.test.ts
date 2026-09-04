import { describe, expect, it } from "vitest";

// No mocks. laneDrop reads the lane machine from agentStatus: a leaf of pure functions, and its only tie to
// the fleet store is a type-only import, which the transform erases. Nothing here reaches the app shell.
import { dropActionFor, dropActionLabel, dropRejection, type DropAction } from "./laneDrop";
import type { FleetAgent } from "./useAgents";

// A drop can't assign a status: the lanes are projections, so it runs the action that CAUSES one, and most
// drops have no action behind them at all.
describe("dropActionFor", () => {
    const none = { plan: false, question: false, permission: false, service: false, capability: false, credential: false, conflict: false };
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
    // One armed condition watch, as the roster carries it. Only its PRESENCE matters to any rule here.
    const watch = { id: `watch-1`, note: `CI run 316`, intervalSeconds: 60, deadlineAt: 2 };

    it("stops a running turn dropped on finished", () => {
        expect(dropActionFor(agent({ status: `running` }), `finished`)).toBe(`stop`);
    });

    // An errored turn never reached its auto-land, so the drop has a FIRST land to try. A conflicted one has
    // already had that land refused, and check mode is atomic: pressing it again against an unchanged
    // workspace fails identically, which is what made this drop a guaranteed no-op.
    it("lands work whose turn errored out before it could land", () => {
        expect(dropActionFor(agent({ status: `error` }), `finished`)).toBe(`land`);
    });

    // Same shape, different cause: the daemon died under this one, so its auto-land never ran either and its
    // worktree still holds however far it got.
    it("lands work whose turn was cut off by the daemon dying", () => {
        expect(dropActionFor(agent({ status: `interrupted` }), `finished`)).toBe(`land`);
    });

    // And once more for the turn the USER cut off: the auto-land is skipped for an aborted turn precisely so
    // half-finished work doesn't land itself, which leaves this drop as the way to say "actually, keep it".
    it("lands work whose turn the user stopped", () => {
        expect(dropActionFor(agent({ status: `stopped` }), `finished`)).toBe(`land`);
    });

    // While it is still going out, though, there is nothing to offer: the stop it would send has been sent,
    // and the worktree is a live turn's until the unwind finishes. Both ways of ending a turn by hand answer
    // the same, including the one whose card is already drawn in Finished: "Already finished" would be a beat
    // early over a turn whose generator has not let go yet.
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

    /* AN ARMED WATCH IS WHAT KEEPS THE CARD OUT OF FINISHED, so disarming it is the action the drop invokes,
     * exactly as a running turn's drop invokes the stop that ends it. Without this the gesture had no answer
     * for the one card the lane change put in its way, and refused it with a sentence about answering an agent
     * that had asked nothing. */
    it("stops the watches of a card dropped on finished", () => {
        expect(dropActionFor(agent({ status: `idle`, watches: [watch] }), `finished`)).toBe(`unwatch`);
    });

    // A watch is a timer, not a worktree: a conversation working in the shared tree arms them exactly as
    // readily, and has no land, resolve or discard for the branch guard to be protecting.
    it("stops the watches of a workspace conversation too, which has no branch to act on", () => {
        expect(dropActionFor(agent({ status: `idle`, branch: undefined, watches: [watch] }), `finished`)).toBe(`unwatch`);
    });

    // Something more pressing is behind the drop on any card that is BLOCKED, and the rules already know what
    // each of those is worth. A watch never gets to speak over an unanswered question or a refused land.
    it("yields to whatever else the card is blocked on", () => {
        expect(dropActionFor(agent({ status: `error`, watches: [watch] }), `finished`)).toBe(`land`);
        expect(dropActionFor(agent({ status: `conflict`, watches: [watch] }), `finished`)).toBe(`resolve`);
        expect(dropActionFor(agent({ status: `idle`, attention: { ...none, question: true }, watches: [watch] }), `finished`)).toBeUndefined();
    });

    // And the running turn still outranks it: the stop is what that drop has always meant, and the watch is
    // still armed underneath it afterwards. A turn the daemon is putting back on its feet is refused outright,
    // watch or no watch, which is what it was refused for before any of this.
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

    // Both client-only standings, because they refuse for one reason: the daemon has no entry for either, so
    // every action behind a drop addresses an id it has never heard of. A refused send is the one that looks
    // most like it should work: it sits in Attention, where a drop on Finished otherwise lands the work.
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

    // The hint is the only thing that teaches the board's rules, so a refusal must always carry one, and an
    // accepted drop must never carry one.
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

    // The hint is the ghost's whole promise, so an action with no verb of its own would silently borrow
    // another's, which is how "Discard this agent" came to be the fallback for anything unnamed.
    it("names every action it can return", () => {
        const labels = ([`land`, `resolve`, `stop`, `discard`, `unwatch`] as const satisfies readonly DropAction[]).map(dropActionLabel);
        expect(labels).toEqual([`Land the work`, `Ask the agent to resolve it`, `Stop the turn`, `Discard this agent`, `Stop watching`]);
        expect(new Set(labels).size).toBe(labels.length);
    });
});

/* A CARD FROM ANOTHER SANDBOX. Three of the five actions are calls addressed by agent id and cross intact; the
 * two that are not need something this browser holds for one daemon at a time, and the refusal has to SAY that
 * rather than springing the card back with a sentence about the lane. */
describe("a card whose agent is in another sandbox", () => {
    const none = { plan: false, question: false, permission: false, service: false, capability: false, credential: false, conflict: false };
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

    // Asking the agent to rebase SENDS A TURN, which needs the conversation the chat singleton holds for the
    // active daemon alone. The same card in this box would resolve.
    it("refuses to ask the agent to resolve, and says the sandbox is why", () => {
        const conflicted = elsewhere({ status: `conflict`, attention: { ...none, conflict: true } });
        expect(dropActionFor({ ...conflicted, sandboxId: undefined }, `finished`)).toBe(`resolve`);
        expect(dropActionFor(conflicted, `finished`)).toBeUndefined();
        expect(dropRejection(conflicted, `finished`)).toContain(`sandbox`);
        expect(dropRejection(conflicted, `finished`)).not.toEqual(dropRejection(elsewhere({ status: `idle` }), `active`));
    });

    // Ending a watch writes through the fleet store, which IS the active daemon's roster and has no entry for
    // this agent: the optimistic write would take a card off a list it was never on.
    it("refuses to end a watch, and says the sandbox is why", () => {
        const watching = elsewhere({ status: `idle`, watches: [watch] });
        const conflicted = elsewhere({ status: `conflict`, attention: { ...none, conflict: true } });
        expect(dropActionFor({ ...watching, sandboxId: undefined }, `finished`)).toBe(`unwatch`);
        expect(dropActionFor(watching, `finished`)).toBeUndefined();
        expect(dropRejection(watching, `finished`)).toContain(`sandbox`);
        expect(dropRejection(watching, `finished`)).not.toEqual(dropRejection(conflicted, `finished`));
    });

    // The box is only ever the reason when the drop would OTHERWISE have worked: a card with nothing to offer
    // this gesture keeps the refusal that is actually true of it.
    it("keeps the ordinary refusal when the box was never the obstacle", () => {
        expect(dropRejection(elsewhere({ status: `idle` }), `active`)).toContain(`message`);
    });
});
