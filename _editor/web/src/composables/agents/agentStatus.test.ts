import type { AgentStatus, AgentWatch } from "@intentic/sandbox-contract";
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
    watchLine,
    watching,
} from "./agentStatus";

// No mocks: agentStatus is a leaf of pure functions, which is the point of it living apart from the fleet
// store: useAgents pulls useChat pulls the router, and none of that is needed to place an agent.
const none = { plan: false, question: false, permission: false, service: false, capability: false, conflict: false };
// One armed watch, as the roster carries it. `deadlineAt` is relative to NOW at call time, which is what every
// countdown assertion below reads against, so the fixtures state the distance and never a wall-clock instant.
const NOW = 1_700_000_000_000;
const watch = (over: Partial<AgentWatch> = {}): AgentWatch => ({
    id: `watch-1`,
    note: `CI run 316 on intentic/intentic`,
    intervalSeconds: 60,
    deadlineAt: NOW + 42 * 60 * 1000,
    ...over,
});

// The kanban lane projection: pure over status + attention, so "finished" needs no explicit action:
// a cleanly-completed, auto-landed turn reads landed/idle and the card moves lanes on the next roster frame.
describe("laneOf", () => {
    it("routes pending plan/question/conflict and errors to attention", () => {
        expect(laneOf({ status: `running`, attention: { ...none, plan: true } })).toBe(`attention`);
        expect(laneOf({ status: `running`, attention: { ...none, question: true } })).toBe(`attention`);
        expect(laneOf({ status: `conflict`, attention: { ...none, conflict: true } })).toBe(`attention`);
        expect(laneOf({ status: `awaiting`, attention: none })).toBe(`attention`);
        expect(laneOf({ status: `error`, attention: none })).toBe(`attention`);
    });

    /* The lane a turn lands in when the DAEMON dies under it: a container rebuild, a crash. Its attention
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

    // A sent turn the daemon has not filed yet is work in flight and belongs beside the rest of it: the only
    // thing that separates it from `running` is whose account of it the card is drawing.
    it("routes a sent-but-unfiled turn to active", () => {
        expect(laneOf({ status: `starting`, attention: none })).toBe(`active`);
    });

    /* THE TWO CLIENT-ONLY STANDINGS ARE NOT ONE. A draft is the tab you are about to type into; a REFUSED send
     * is a card for work that never started and never will until the user acts. Filing the second one under
     * Active, which is what reading it as a draft did: put cards nobody can do anything with above the agents
     * actually working, in the lane whose whole claim is that they are. */
    it("routes a refused send to attention, apart from the draft it is not", () => {
        expect(laneOf({ status: `failed`, attention: none })).toBe(`attention`);
    });

    /* THE STOP, IN ITS TWO HALVES. `stopping` is the seconds between the press and the turn's last breath: the
     * turn is still live and the card stays exactly where it is, so the stop costs one lane change rather than
     * two. `stopped` then lands beside `interrupted`: an ending that came before the work was done, whose
     * worktree only a message from the user carries forward. */
    it("holds a stopping turn in active and files the stopped one under attention", () => {
        expect(laneOf({ status: `stopping`, attention: none })).toBe(`active`);
        expect(laneOf({ status: `stopped`, attention: none })).toBe(`attention`);
    });

    /* THE SAME ARGUMENT AT THE OTHER END OF A TURN. A turn the daemon is already re-running: a rotated token
     * being re-minted, an outage being waited out: has stopped without ending, and reading that as finished is
     * what dropped a card into Finished for the couple of seconds a 401 takes to repair and then hauled it back
     * into Active. Two lane changes to say nothing, on work nobody had to do anything about. */
    it("keeps a turn that is coming back in active, not finished", () => {
        expect(laneOf({ status: `resuming`, attention: none })).toBe(`active`);
    });

    it("routes landed and idle agents to finished: the auto-finish rule", () => {
        expect(laneOf({ status: `landed`, attention: none })).toBe(`finished`);
        expect(laneOf({ status: `idle`, attention: none })).toBe(`finished`);
    });

    it("routes ready (held for a deliberate land) to finished, not attention", () => {
        // The user CHOSE to hold work for review: a card in this state is an offer, never a warning, and
        // routing it to Attention would teach people to ignore that lane (see blocked()'s note).
        expect(laneOf({ status: `ready`, attention: none })).toBe(`finished`);
    });

    /* THE SAME ARGUMENT AS `resuming`, STRETCHED FROM SECONDS TO HOURS. An agent that armed a condition watch
     * ended its turn, so the daemon files it idle, and every reading above would call that finished. Then the
     * check passes at 3am and the conversation starts working, in front of somebody who was told it was done.
     *
     * Active and not Attention: nothing is owed by the USER here. The agent is waiting on the world. */
    it("keeps an idle agent with an armed watch in active: it will run again by itself", () => {
        expect(laneOf({ status: `idle`, attention: none, watches: [watch()] })).toBe(`active`);
        expect(laneOf({ status: `landed`, attention: none, watches: [watch()] })).toBe(`active`);
    });

    // The empty list is the same as no list: the daemon clears the projection when the last watch ends, and a
    // card whose watch already fired has nothing left to wait for.
    it("treats a conversation whose watches have all ended as finished again", () => {
        expect(laneOf({ status: `idle`, attention: none, watches: [] })).toBe(`finished`);
        expect(laneOf({ status: `idle`, attention: none })).toBe(`finished`);
    });

    // A watch does not outrank a question. Blocked-on-the-user is read first, so the lane goes on meaning what
    // it says: this card needs a person, whatever else is also true of it.
    it("still routes a watching agent that needs the user to attention", () => {
        expect(laneOf({ status: `awaiting`, attention: { ...none, question: true }, watches: [watch()] })).toBe(`attention`);
    });
});

/* The words each state wears where a surface has room for them: the detail page's chip, the chat tab's
 * aria-label. Only the pair that has to be told apart is pinned: a turn ENDING by the user's hand and one
 * stopped mid-flight by something the daemon is repairing look identical to anyone reading a spinner, and
 * calling either of them by the other's name is the whole complaint. */
describe("agentStatusMeta", () => {
    it("names a turn that is coming back apart from one that is going away", () => {
        expect(agentStatusMeta(`resuming`)).toMatchObject({ label: `Resuming…`, icon: `spinner`, spin: true });
        expect(agentStatusMeta(`stopping`)).toMatchObject({ label: `Stopping…` });
    });

    // And a sent turn apart from a filed one. Same spinner and same hue: it IS work in flight, because the
    // difference the word carries is about the RECORD, not about how busy the agent is.
    it("names a sent turn the daemon has not filed yet", () => {
        expect(agentStatusMeta(`starting`)).toMatchObject({ label: `Starting…`, icon: `spinner`, spin: true });
    });
});

/* WHICH CARDS HAVE NO REGISTRY ENTRY BEHIND THEM: the one gate every fleet verb is refused through (archive,
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

    // The elapsed on a starting card runs from the send, so the live readouts have to treat it as a live turn:
    // while the hands-off guards keep refusing it one question earlier, on `unregistered` above.
    it("counts a sent turn as in flight, so its card ticks like the work it is", () => {
        expect(turnInFlight({ status: `starting`, attention: none })).toBe(true);
        expect(blocked({ status: `starting`, attention: none })).toBe(false);
        expect(awaitingUser({ status: `starting`, attention: none })).toBe(false);
    });
});

/* The Changes legend's mark. The ONE property worth asserting is that it never disagrees with the board about
 * the same agent: a mark on a chip whose card sits in Finished (or a bare chip whose card sits in Attention)
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
    it("stands still: a per-chip mark may not animate", () => {
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
        // Still the active-lane mark: the turn IS still working, on its own way out.
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

    /* The one active card that is not working. "Still working" would be a plain falsehood about an agent whose
     * turn ended twenty minutes ago and which is now waiting on somebody else's CI, so the mark says which
     * kind of unfinished it is. A watching agent that IS mid-turn is working, and reads as such. */
    it("tells a card waiting on a condition apart from one still working", () => {
        expect(unfinishedMark({ status: `idle`, attention: none, watches: [watch()] })?.label).toBe(`Waiting on a condition`);
        expect(unfinishedMark({ status: `running`, attention: none, watches: [watch()] })?.label).toBe(`Still working`);
    });
});

/* The card's compact readout for an armed watch: glyph, phrase and clock, the same grammar the running card's
 * tool line uses, because a board is scanned down one column. */
describe("watchLine", () => {
    it("says nothing at all for the conversations that are not watching anything", () => {
        expect(watchLine({ status: `idle`, attention: none }, NOW)).toBeUndefined();
        expect(watchLine({ status: `idle`, attention: none, watches: [] }, NOW)).toBeUndefined();
        expect(watching({ status: `idle`, attention: none, watches: [] })).toBe(false);
    });

    /* THE NOTE IS THE PHRASE. The agent wrote one line about what it is waiting for so that somebody could
     * read it here; "Watching" alone is the glyph's job and tells a user nothing they could act on. */
    it("leads with the agent's own note and counts down to the deadline", () => {
        const line = watchLine({ status: `idle`, attention: none, watches: [watch()] }, NOW);
        expect(line?.text).toBe(`CI run 316 on intentic/intentic`);
        expect(line?.countdown).toBe(`42m 0s`);
    });

    /* Several notes truncated into a 280px column are three things nobody reads, so they collapse to a count.
     * The clock still names the SOONEST deadline: what it answers is "when does this card next move", and the
     * next one to give up is the next time this conversation comes back to life. */
    it("collapses several watches to a count and counts down to the first of them", () => {
        const line = watchLine(
            {
                status: `idle`,
                attention: none,
                watches: [watch({ deadlineAt: NOW + 3 * 60 * 60 * 1000 }), watch({ id: `watch-2`, note: `deploy`, deadlineAt: NOW + 5 * 60 * 1000 })],
            },
            NOW,
        );
        expect(line?.text).toBe(`Watching 2 conditions`);
        expect(line?.countdown).toBe(`5m 0s`);
    });

    /* The hint carries what the line could not, and one thing neither the note nor the clock implies: that the
     * end of this wait is the agent WORKING AGAIN, not a notification. That is the fact a user cannot guess
     * and the one that decides whether they leave the watch armed. */
    it("spells the pacing, every note in full, and what happens when it ends", () => {
        const line = watchLine({ status: `idle`, attention: none, watches: [watch(), watch({ id: `watch-2`, note: `deploy` })] }, NOW);
        expect(line?.hint).toContain(`CI run 316 on intentic/intentic`);
        expect(line?.hint).toContain(`deploy`);
        expect(line?.hint).toContain(`checked every 60s`);
        expect(line?.hint).toContain(`wakes this conversation`);
    });

    // Pacing in the fewest characters that stay true: a half-hourly check reads as minutes, not as "1800s".
    it("says a slow cadence in minutes", () => {
        expect(watchLine({ status: `idle`, attention: none, watches: [watch({ intervalSeconds: 1800 })] }, NOW)?.hint).toContain(
            `checked every 30m`,
        );
    });
});
