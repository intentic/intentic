import type { AgentStatus } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import {
    type AgentStanding,
    agentStatusMeta,
    awaitingUser,
    blocked,
    type ClientAgentStatus,
    laneOf,
    turnInFlight,
    unfinishedMark,
    unregistered,
    waitingLine,
} from "./agentStatus";

// No mocks: agentStatus is a leaf of pure functions, which is the point of it living apart from the fleet
// store — useAgents pulls useChat pulls the router, and none of that is needed to place an agent.
const none = { plan: false, question: false, permission: false, conflict: false };

// The kanban lane projection — pure over status + attention, so "finished" needs no explicit action:
// a cleanly-completed, auto-landed turn reads landed/idle and the card moves lanes on the next roster frame.
describe("laneOf", () => {
    it("routes pending plan/question/conflict and errors to attention", () => {
        expect(laneOf({ status: `running`, attention: { ...none, plan: true } })).toBe(`attention`);
        expect(laneOf({ status: `running`, attention: { ...none, question: true } })).toBe(`attention`);
        expect(laneOf({ status: `conflict`, attention: { ...none, conflict: true } })).toBe(`attention`);
        expect(laneOf({ status: `awaiting`, attention: none })).toBe(`attention`);
        expect(laneOf({ status: `error`, attention: none })).toBe(`attention`);
    });

    /* The lane a turn lands in when the DAEMON dies under it — a container rebuild, a crash. Its attention
     * flags were runtime state and died with it, so the only thing left saying "this one stopped mid-task" is
     * the status the registry wrote when the turn began. Reading that as finished is what put an agent parked
     * on an unanswered question into the Finished lane. */
    it("routes an interrupted turn to attention, not finished", () => {
        expect(laneOf({ status: `interrupted`, attention: none })).toBe(`attention`);
    });

    it("routes running turns and fresh drafts to active", () => {
        expect(laneOf({ status: `running`, attention: none })).toBe(`active`);
        expect(laneOf({ status: `draft`, attention: none })).toBe(`active`);
    });

    // A sent turn the daemon has not filed yet is work in flight and belongs beside the rest of it — the only
    // thing that separates it from `running` is whose account of it the card is drawing.
    it("routes a sent-but-unfiled turn to active", () => {
        expect(laneOf({ status: `starting`, attention: none })).toBe(`active`);
    });

    /* THE TWO CLIENT-ONLY STANDINGS ARE NOT ONE. A draft is the tab you are about to type into; a REFUSED send
     * is a card for work that never started and never will until the user acts. Filing the second one under
     * Active — which is what reading it as a draft did — put cards nobody can do anything with above the agents
     * actually working, in the lane whose whole claim is that they are. */
    it("routes a refused send to attention, apart from the draft it is not", () => {
        expect(laneOf({ status: `failed`, attention: none })).toBe(`attention`);
    });

    /* THE STOP, IN ITS TWO HALVES. `stopping` is the seconds between the press and the turn's last breath — the
     * turn is still live and the card stays exactly where it is, so the stop costs one lane change rather than
     * two. `stopped` then lands beside `interrupted`: an ending that came before the work was done, whose
     * worktree only a message from the user carries forward. */
    it("holds a stopping turn in active and files the stopped one under attention", () => {
        expect(laneOf({ status: `stopping`, attention: none })).toBe(`active`);
        expect(laneOf({ status: `stopped`, attention: none })).toBe(`attention`);
    });

    /* THE SAME ARGUMENT AT THE OTHER END OF A TURN. A turn the daemon is already re-running — a rotated token
     * being re-minted, an outage being waited out — has stopped without ending, and reading that as finished is
     * what dropped a card into Finished for the couple of seconds a 401 takes to repair and then hauled it back
     * into Active. Two lane changes to say nothing, on work nobody had to do anything about. */
    it("keeps a turn that is coming back in active, not finished", () => {
        expect(laneOf({ status: `resuming`, attention: none })).toBe(`active`);
    });

    it("routes landed and idle agents to finished — the auto-finish rule", () => {
        expect(laneOf({ status: `landed`, attention: none })).toBe(`finished`);
        expect(laneOf({ status: `idle`, attention: none })).toBe(`finished`);
    });

    it("routes ready (held for a deliberate land) to finished, not attention", () => {
        // The user CHOSE to hold work for review — a card in this state is an offer, never a warning, and
        // routing it to Attention would teach people to ignore that lane (see blocked()'s note).
        expect(laneOf({ status: `ready`, attention: none })).toBe(`finished`);
    });
});

/* The words each state wears where a surface has room for them — the detail page's chip, the chat tab's
 * aria-label. Only the pair that has to be told apart is pinned: a turn ENDING by the user's hand and one
 * stopped mid-flight by something the daemon is repairing look identical to anyone reading a spinner, and
 * calling either of them by the other's name is the whole complaint. */
describe("agentStatusMeta", () => {
    it("names a turn that is coming back apart from one that is going away", () => {
        expect(agentStatusMeta(`resuming`)).toMatchObject({ label: `Resuming…`, icon: `spinner`, spin: true });
        expect(agentStatusMeta(`stopping`)).toMatchObject({ label: `Stopping…` });
    });

    // And a sent turn apart from a filed one. Same spinner and same hue — it IS work in flight — because the
    // difference the word carries is about the RECORD, not about how busy the agent is.
    it("names a sent turn the daemon has not filed yet", () => {
        expect(agentStatusMeta(`starting`)).toMatchObject({ label: `Starting…`, icon: `spinner`, spin: true });
    });
});

/* WHICH CARDS HAVE NO REGISTRY ENTRY BEHIND THEM — the one gate every fleet verb is refused through (archive,
 * review, land, drop, prefetch) and, on the way in, the one that decides whether opening a card may latch its tab
 * as a registered conversation. `starting` had to join it: while a sent-but-unfiled turn wore the wire's
 * `running`, the click that opened such a card latched it and the card left the board with no entry to replace
 * it. Asserted against the full status list rather than one case, so a state added later has to answer here. */
describe("unregistered", () => {
    it("names every client-only standing and nothing the daemon assigns", () => {
        expect(([`draft`, `starting`, `failed`, `resumed`] as ClientAgentStatus[]).map(unregistered)).toEqual([true, true, true, true]);
        expect(
            (
                [
                    `idle`,
                    `running`,
                    `awaiting`,
                    `ready`,
                    `landed`,
                    `conflict`,
                    `error`,
                    `interrupted`,
                    `stopping`,
                    `stopped`,
                    `resuming`,
                ] as AgentStatus[]
            ).map(unregistered),
        ).not.toContain(true);
    });

    // The elapsed on a starting card runs from the send, so the live readouts have to treat it as a live turn —
    // while the hands-off guards keep refusing it one question earlier, on `unregistered` above.
    it("counts a sent turn as in flight, so its card ticks like the work it is", () => {
        expect(turnInFlight({ status: `starting`, attention: none })).toBe(true);
        expect(blocked({ status: `starting`, attention: none })).toBe(false);
        expect(awaitingUser({ status: `starting`, attention: none })).toBe(false);
    });
});

// Why a sent turn has not started, in the words the chat's own notice uses — the two surfaces describe one wait.
describe("waitingLine", () => {
    it("names the dependency wait, and degrades an unknown reason to itself", () => {
        expect(waitingLine(`dependencies`)).toBe(`Waiting for dependency setup`);
        expect(waitingLine(`something new`)).toBe(`Waiting for something new`);
        expect(waitingLine(undefined)).toBeUndefined();
    });
});

/* The Changes legend's mark. The ONE property worth asserting is that it never disagrees with the board about
 * the same agent — a mark on a chip whose card sits in Finished (or a bare chip whose card sits in Attention)
 * is the user watching two surfaces contradict each other, which is exactly what a second status list here
 * produced before this became a reading of laneOf. */
describe("unfinishedMark", () => {
    const STATUSES: readonly (AgentStatus | ClientAgentStatus)[] = [
        `idle`,
        `running`,
        `awaiting`,
        `ready`,
        `landed`,
        `conflict`,
        `error`,
        `interrupted`,
        `stopping`,
        `stopped`,
        `resuming`,
        `draft`,
        `starting`,
        `failed`,
    ];
    const FLAGS: readonly AgentStanding[`attention`][] = [
        none,
        { ...none, plan: true },
        { ...none, question: true },
        { ...none, permission: true },
        { ...none, conflict: true },
    ];

    it("marks exactly what the board does not call finished, across every state", () => {
        for (const status of STATUSES) {
            for (const attention of FLAGS) {
                const agent = { status, attention };
                expect({ status, attention, marked: unfinishedMark(agent) !== undefined }).toEqual({
                    status,
                    attention,
                    marked: laneOf(agent) !== `finished`,
                });
            }
        }
    });

    // There is one of these per contributing session, so whatever the mark does, a busy review does four times
    // at once. It has to say "unfinished" while standing perfectly still; the ring is what tells it apart from
    // a chip's flat identity tint now that the pulse is gone.
    it("stands still — a per-chip mark may not animate", () => {
        for (const status of STATUSES) {
            for (const attention of FLAGS) {
                expect(unfinishedMark({ status, attention })?.dot ?? ``).not.toMatch(/\banimate-/);
            }
        }
        expect(unfinishedMark({ status: `running`, attention: none })?.dot).toContain(`ring-2`);
    });

    it("names why, in the board's own words", () => {
        expect(unfinishedMark({ status: `running`, attention: none })?.label).toBe(`Still working`);
        expect(unfinishedMark({ status: `running`, attention: { ...none, question: true } })?.label).toBe(`Question for you`);
        expect(unfinishedMark({ status: `conflict`, attention: none })?.label).toBe(`Land conflict`);
        expect(unfinishedMark({ status: `error`, attention: none })?.label).toBe(`Error`);
        expect(unfinishedMark({ status: `interrupted`, attention: none })?.label).toBe(`Interrupted`);
        expect(unfinishedMark({ status: `stopped`, attention: none })?.label).toBe(`Stopped`);
        // Not "failed" and not "error": nothing ran to fail, and there is no agent to have erred. What the chip
        // has to convey is that this card is not an agent at all.
        expect(unfinishedMark({ status: `failed`, attention: none })?.label).toBe(`Didn't start`);
        // Still the active-lane mark: the turn IS still working — on its own way out.
        expect(unfinishedMark({ status: `stopping`, attention: none })?.label).toBe(`Still working`);
        // And on its way back in: the blocker is the daemon's to clear, so nothing about this chip is the
        // user's business beyond "not done yet".
        expect(unfinishedMark({ status: `resuming`, attention: none })?.label).toBe(`Still working`);
        // A turn parked before any flag went up has nothing more specific to say than that it stopped.
        expect(unfinishedMark({ status: `awaiting`, attention: none })?.label).toBe(`Waiting on you`);
    });

    // An id the roster no longer carries: archived, or retired by the retention sweep. Leaving the board is
    // what a finished session does, so absence is an answer rather than a gap.
    it("says nothing for an agent the roster has dropped", () => {
        expect(unfinishedMark(undefined)).toBeUndefined();
    });
});
