import type { AgentStatus, AgentWatch } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import {
    type AgentStanding,
    agentStatusMeta,
    attentionReason,
    awaitingUser,
    blocked,
    type ClientAgentStatus,
    laneOf,
    limitCountdown,
    reviewAction,
    turnInFlight,
    unfinishedMark,
    unregistered,
    watchLine,
    watching,
    effectiveLimitMove,
} from "./agentStatus";

// No mocks: agentStatus is a pure-function leaf, apart from the fleet store's chain through useChat and the router.
const none = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
// One armed watch as the roster carries it; `deadlineAt` is relative to NOW, and every countdown assertion below states
// a distance rather than a wall-clock instant.
const NOW = 1_700_000_000_000;
const watch = (over: Partial<AgentWatch> = {}): AgentWatch => ({
    id: `watch-1`,
    note: `CI run 316 on intentic/intentic`,
    intervalSeconds: 60,
    deadlineAt: NOW + 42 * 60 * 1000,
    ...over,
});

// The kanban lane projection, pure over status + attention: a cleanly-completed, auto-landed turn needs no explicit
// action, since idle/landed already reads as finished.
describe("laneOf", () => {
    it("routes pending plan/question/conflict and errors to attention", () => {
        expect(laneOf({ status: `running`, attention: { ...none, plan: true } })).toBe(`attention`);
        expect(laneOf({ status: `running`, attention: { ...none, question: true } })).toBe(`attention`);
        expect(laneOf({ status: `conflict`, attention: { ...none, conflict: true } })).toBe(`attention`);
        expect(laneOf({ status: `awaiting`, attention: none })).toBe(`attention`);
        expect(laneOf({ status: `error`, attention: none })).toBe(`attention`);
    });

    // The lane a turn lands in when the daemon dies under it: its attention flags were runtime state and died with it,
    // so only the status it started with says the turn stopped mid-task.
    it("routes an interrupted turn to attention, not finished", () => {
        expect(laneOf({ status: `interrupted`, attention: none })).toBe(`attention`);
    });

    it("routes running turns and fresh drafts to active", () => {
        expect(laneOf({ status: `running`, attention: none })).toBe(`active`);
        expect(laneOf({ status: `draft`, attention: none })).toBe(`active`);
    });

    // A sent-but-unfiled turn is work in flight; only whose account of it the card draws differs from `running`.
    it("routes a sent-but-unfiled turn to active", () => {
        expect(laneOf({ status: `starting`, attention: none })).toBe(`active`);
    });

    // A draft is the tab about to be typed into; a refused send is a card for work that never started and won't until
    // the user acts, so it belongs in attention, not active.
    it("routes a refused send to attention, apart from the draft it is not", () => {
        expect(laneOf({ status: `failed`, attention: none })).toBe(`attention`);
    });

    // `stopping` and `stopped` both file under attention from the press onward: an ending before the work was done,
    // whose worktree only a further message carries forward.
    it("files both halves of a stop under attention, from the press onwards", () => {
        expect(laneOf({ status: `stopping`, attention: none })).toBe(`attention`);
        expect(laneOf({ status: `stopped`, attention: none })).toBe(`attention`);
    });

    // Waving a question away also ends the turn, but nothing is owed afterward, so it files under finished instead,
    // from the press onward, unlike a stop.
    it("files a dismissed card under finished, from the press onwards", () => {
        expect(laneOf({ status: `dismissing`, attention: none })).toBe(`finished`);
        expect(laneOf({ status: `idle`, attention: none })).toBe(`finished`);
    });

    // Both unwinds are still live turns to every hands-off guard, whatever lane they're drawn in: the worktree is the
    // turn's working state until the generator lets go.
    it("keeps both endings in flight for the hands-off guards", () => {
        expect(turnInFlight({ status: `stopping`, attention: none })).toBe(true);
        expect(turnInFlight({ status: `dismissing`, attention: none })).toBe(true);
    });

    // A turn the daemon is already re-running (a rotated token, an outage) has stopped without ending, so it stays
    // active rather than briefly reading as finished.
    it("keeps a turn that is coming back in active, not finished", () => {
        expect(laneOf({ status: `resuming`, attention: none })).toBe(`active`);
    });

    it("routes landed and idle agents to finished: the auto-finish rule", () => {
        expect(laneOf({ status: `landed`, attention: none })).toBe(`finished`);
        expect(laneOf({ status: `idle`, attention: none })).toBe(`finished`);
    });

    it("routes ready (held for a deliberate land) to finished, not attention", () => {
        // The user chose to hold work for review: an offer, never a warning, so it must not route to Attention.
        expect(laneOf({ status: `ready`, attention: none })).toBe(`finished`);
    });

    // An agent with an armed watch ended its turn and files idle, but it will run again by itself: active, not
    // attention, since nothing is owed by the user here.
    it("keeps an idle agent with an armed watch in active: it will run again by itself", () => {
        expect(laneOf({ status: `idle`, attention: none, watches: [watch()] })).toBe(`active`);
        expect(laneOf({ status: `landed`, attention: none, watches: [watch()] })).toBe(`active`);
    });

    // An empty watch list is the same as no list: the daemon clears the projection when the last watch ends.
    it("treats a conversation whose watches have all ended as finished again", () => {
        expect(laneOf({ status: `idle`, attention: none, watches: [] })).toBe(`finished`);
        expect(laneOf({ status: `idle`, attention: none })).toBe(`finished`);
    });

    // A watch never outranks a question: blocked-on-the-user is read first, so the lane still means what it says.
    it("still routes a watching agent that needs the user to attention", () => {
        expect(laneOf({ status: `awaiting`, attention: { ...none, question: true }, watches: [watch()] })).toBe(`attention`);
    });
});

// Only the pair that must be told apart is pinned here: an ending by the user's hand and one stopped mid-flight by
// something the daemon is repairing look identical as a spinner.
describe("agentStatusMeta", () => {
    it("names a turn that is coming back apart from one that is going away", () => {
        expect(agentStatusMeta(`resuming`)).toMatchObject({ label: `Resuming…`, icon: `spinner`, spin: true });
        expect(agentStatusMeta(`stopping`)).toMatchObject({ label: `Stopping…` });
    });

    // A sent turn apart from a filed one: same spinner and hue, since the difference is about the record, not how busy
    // the agent is.
    it("names a sent turn the daemon has not filed yet", () => {
        expect(agentStatusMeta(`starting`)).toMatchObject({ label: `Starting…`, icon: `spinner`, spin: true });
    });
});

// The one gate every fleet verb is refused through (archive, review, land, drop, prefetch), and the one that decides
// whether opening a card latches its tab as registered.
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

    // The elapsed on a starting card runs from the send, so live readouts treat it as a live turn even while other
    // guards refuse it one status earlier.
    it("counts a sent turn as in flight, so its card ticks like the work it is", () => {
        expect(turnInFlight({ status: `starting`, attention: none })).toBe(true);
        expect(blocked({ status: `starting`, attention: none })).toBe(false);
        expect(awaitingUser({ status: `starting`, attention: none })).toBe(false);
    });
});

// The Changes legend's mark must never disagree with the board about the same agent: a mark on a Finished card, or a
// bare chip on an Attention one, is two surfaces contradicting each other.
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

    // One of these draws per contributing session, so a busy review does it four times at once; the ring, not a pulse,
    // tells it apart from a chip's flat identity tint while standing still.
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
        // Not "failed" and not "error": nothing ran to fail and there's no agent to have erred, only that this card
        // isn't an agent at all.
        expect(unfinishedMark({ status: `failed`, attention: none })?.label).toBe(`Didn't start`);
        // Not "Still working": the user pressed Stop, and saying so would be the same contradiction the board's lane
        // used to show.
        expect(unfinishedMark({ status: `stopping`, attention: none })?.label).toBe(`Stopping`);
        // A dismissal has left this legend entirely: nothing is unfinished about a card the user waved away.
        expect(unfinishedMark({ status: `dismissing`, attention: none })).toBeUndefined();
        // On its way back in, the blocker is the daemon's to clear, so nothing about this chip is the user's business
        // beyond "not done yet".
        expect(unfinishedMark({ status: `resuming`, attention: none })?.label).toBe(`Still working`);
        // A turn parked before any flag went up has nothing more specific to say than that it stopped.
        expect(unfinishedMark({ status: `awaiting`, attention: none })?.label).toBe(`Waiting on you`);
    });

    // An id the roster no longer carries: archived or retired. Leaving the board is what a finished session does, so
    // absence is itself an answer.
    it("says nothing for an agent the roster has dropped", () => {
        expect(unfinishedMark(undefined)).toBeUndefined();
    });

    // The one active card that isn't working: "Still working" would be false for an agent waiting on someone else's CI,
    // so the mark names which kind of unfinished it is.
    it("tells a card waiting on a condition apart from one still working", () => {
        const waiting = unfinishedMark({ status: `idle`, attention: none, watches: [watch()] });
        const working = unfinishedMark({ status: `running`, attention: none, watches: [watch()] });
        expect(waiting?.label).toContain(`condition`);
        expect(working?.label).toContain(`working`);
        expect(waiting?.label).not.toEqual(working?.label);
    });
});

// Every way a card can be parked on a person must say so in words: `permission` had a verb in one ranked list and no
// chip word in the other, so it fell back to a bare glyph.
describe("attentionReason · every park names itself", () => {
    const FLAGS = [`plan`, `question`, `permission`, `service`, `capability`, `conflict`] as const;

    // The reported bug, pinned as itself: not "some chip appears" but the word, since the complaint was that a glyph is
    // not one.
    it("names a tool permission instead of drawing a bare glyph", () => {
        const parked: AgentStanding = { status: `awaiting`, attention: { ...none, permission: true } };
        expect(attentionReason(parked)).toBe(`Permission`);
        expect(laneOf(parked)).toBe(`attention`);
    });

    // Held to the same measured width the limit chip is pinned at below: this chip is shrink-0 beside a title that
    // isn't, so its characters come off the agent's own name.
    it("keeps the new word inside the width the card was measured at", () => {
        expect(attentionReason({ status: `awaiting`, attention: { ...none, permission: true } })?.length).toBeLessThanOrEqual(12);
    });

    // And not the plan's word: two chips reading the same words over two different asks teaches the reader that a chip
    // doesn't repay a glance.
    it("tells a permission apart from a plan", () => {
        const words = {
            permission: attentionReason({ status: `awaiting`, attention: { ...none, permission: true } }),
            plan: attentionReason({ status: `awaiting`, attention: { ...none, plan: true } }),
        };
        expect(words).toEqual({ permission: `Permission`, plan: `Approval needed` });
    });

    // Asserted over the whole flag set so a flag added later can't ship with nothing to say; `satisfies` in the source
    // makes a missing key a build error, and this catches one with no words behind it.
    it("gives every attention flag both a word and a verb", () => {
        const said = FLAGS.map((flag) => {
            const agent = { status: `awaiting` as const, attention: { ...none, [flag]: true }, branch: `agent/x` };
            return { flag, chip: attentionReason(agent), verb: reviewAction(agent) };
        });
        expect(said).toEqual(FLAGS.map((flag) => ({ flag, chip: expect.stringMatching(/\S/u), verb: expect.stringMatching(/\S/u) })));
    });

    // The chip and the press must rank the same flags the same way: two hand-kept lists once disagreed on setup vs. a
    // plain question, leaving a card with both wearing contradictory instructions.
    it("leads the chip and the press with the same park", () => {
        const both = { status: `awaiting` as const, attention: { ...none, question: true, capability: true }, branch: `agent/x` };
        expect({ chip: attentionReason(both), verb: reviewAction(both) }).toEqual({ chip: `Setup needed`, verb: `Set up` });
    });

    // `awaiting` can hold a park the attention schema has no flag for (a browser or terminal hand-off); "Waiting on
    // you" is the floor, bounded so it never shadows a word that knows the real reason nor leaks onto settled cards.
    it("says the plainest true thing for a park that raises no flag, and nothing at all for no park", () => {
        expect(attentionReason({ status: `awaiting`, attention: none })).toBe(`Waiting on you`);
        expect(attentionReason({ status: `awaiting`, attention: { ...none, capability: true } })).toBe(`Setup needed`);
        const settled: readonly (AgentStatus | ClientAgentStatus)[] = [`running`, `idle`, `landed`, `ready`];
        expect(settled.map((status) => attentionReason({ status, attention: none }))).toEqual(settled.map(() => undefined));
    });
});

// The card's compact readout for an armed watch: glyph, phrase and clock, the same grammar the running card's tool line
// uses since a board is scanned down one column.
describe("watchLine", () => {
    it("says nothing at all for the conversations that are not watching anything", () => {
        expect(watchLine({ status: `idle`, attention: none }, NOW)).toBeUndefined();
        expect(watchLine({ status: `idle`, attention: none, watches: [] }, NOW)).toBeUndefined();
        expect(watching({ status: `idle`, attention: none, watches: [] })).toBe(false);
    });

    // The note is the phrase: the agent wrote what it's waiting for so someone could read it here, since the glyph
    // alone tells nothing actionable.
    it("leads with the agent's own note and counts down to the deadline", () => {
        const armed = watch();
        const line = watchLine({ status: `idle`, attention: none, watches: [armed] }, NOW);
        expect(line?.text).toBe(armed.note);
        expect(line?.countdown).toBe(`42m 0s`);
    });

    // Several notes truncated into a narrow column read as noise, so they collapse to a count; the clock still names
    // the soonest deadline, the next time this conversation comes back to life.
    it("collapses several watches to a count and counts down to the first of them", () => {
        const watches = [watch({ deadlineAt: NOW + 3 * 60 * 60 * 1000 }), watch({ id: `watch-2`, note: `deploy`, deadlineAt: NOW + 5 * 60 * 1000 })];
        const line = watchLine({ status: `idle`, attention: none, watches }, NOW);
        expect(line?.text).toContain(String(watches.length));
        expect(line?.countdown).toBe(`5m 0s`);
    });

    // The hint carries what the line can't: that the end of the wait is the agent working again, not a notification,
    // which is what decides whether a user leaves it armed.
    it("spells the pacing, every note in full, and what happens when it ends", () => {
        const first = watch();
        const second = watch({ id: `watch-2`, note: `deploy` });
        const line = watchLine({ status: `idle`, attention: none, watches: [first, second] }, NOW);
        expect(line?.hint).toContain(first.note);
        expect(line?.hint).toContain(second.note);
        expect(line?.hint).toContain(`60s`);
    });

    // And that it can be ended: a box that explains a mechanism with no exit teaches users the arrangement is theirs to
    // wait out.
    it("names the way out, and what taking it costs", () => {
        expect(watchLine({ status: `idle`, attention: none, watches: [watch()] }, NOW)?.hint).toContain(`Stop watching`);
    });

    // Pacing in the fewest characters that stay true: a half-hourly check reads as minutes, not seconds.
    it("says a slow cadence in minutes", () => {
        expect(watchLine({ status: `idle`, attention: none, watches: [watch({ intervalSeconds: 1800 })] }, NOW)?.hint).toContain(`checked every 30m`);
    });
});

// A spent allowance arrives as `status: "error"` and is a wait rather than a fault, but one that ends only when a
// person acts, unlike a scheduled reset which owes nothing until it sends something through.
const SHUT = { failureCode: `rate_limit`, limitResetsAt: (NOW + 4 * 60 * 60 * 1000) / 1000 };
const OPEN = { failureCode: `rate_limit`, limitResetsAt: (NOW - 60 * 60 * 1000) / 1000 };
describe("a spent allowance", () => {
    // The lane, in both halves of the wait: shut or open makes no difference to whether a person is needed, since the
    // turn goes nowhere until somebody sends it.
    it("stays in attention for the whole wait, shut window or open", () => {
        expect(laneOf({ status: `error`, attention: none, ...SHUT })).toBe(`attention`);
        expect(laneOf({ status: `error`, attention: none, ...OPEN })).toBe(`attention`);
        expect(blocked({ status: `error`, attention: none, ...SHUT })).toBe(true);
    });

    // The one card that needs no person: armed, the daemon resends the held turn at the reset itself, so this session
    // progresses on its own exactly as a resuming one does.
    it("leaves attention only when something is already booked to send it", () => {
        const booked = { status: `error`, attention: none, ...SHUT, limitScheduled: true } as const;
        expect(blocked(booked)).toBe(false);
        expect(laneOf(booked)).toBe(`active`);
        // Active, not finished: it will run again tonight, and a settled lane would call that over.
        expect(unfinishedMark(booked)?.label).toBe(`Sends itself again`);
    });

    // The chip does the work: the card carries no other sentence about the wall, and both halves of the wait name the
    // same condition since the reader's question has the same answer either side of the reset.
    it("names the condition in the corner instead of calling it an error", () => {
        expect(attentionReason({ status: `error`, attention: none, ...SHUT })).toBe(`Usage limit`);
        expect(attentionReason({ status: `error`, attention: none, ...OPEN })).toBe(`Usage limit`);
    });

    // A layout constraint, not taste: the chip is shrink-0 beside a title that isn't, so every character it grows comes
    // off the agent's own name. Pinned for this label only; longer siblings on the same chip are unmeasured.
    it("keeps the chip short enough that the card can still say which agent it is", () => {
        expect(attentionReason({ status: `error`, attention: none, ...SHUT })?.length).toBeLessThanOrEqual(12);
    });

    // "View error" points at a transcript ending in a polite refusal; there's nothing to diagnose, so the label names
    // the destination.
    it("does not offer to view an error", () => {
        expect(reviewAction({ status: `error`, attention: none, branch: `agent/x`, ...SHUT })).toBe(`Open chat`);
    });

    // The clock corner: minutes while that's a number a person can hold, the day and hour once it isn't, since a weekly
    // pool measured in hours is arithmetic, not information.
    it("counts down while that is a number, and names the day once it is not", () => {
        const soon = { failureCode: `rate_limit`, limitResetsAt: (NOW + 40 * 60 * 1000) / 1000 };
        expect(limitCountdown({ status: `error`, attention: none, ...soon }, NOW)).toBe(`40m 0s`);
        // Four hours out: a clock time, not a count. The exact string is the locale's; this pins the shape.
        expect(limitCountdown({ status: `error`, attention: none, ...SHUT }, NOW)).toMatch(/\d{2}:\d{2}/u);
    });

    // Once the window is open there's no instant left to count to, and a provider that published none (Grok, Cursor)
    // never had one; either way the corner keeps its ordinary date.
    it("shows no clock once the window is open, or when nobody named one", () => {
        expect(limitCountdown({ status: `error`, attention: none, ...OPEN }, NOW)).toBeUndefined();
        expect(limitCountdown({ status: `error`, attention: none, failureCode: `rate_limit` }, NOW)).toBeUndefined();
    });

    // The guard that keeps all of the above honest: none of it may reach a failure that is a real failure, which keeps
    // its red line, amber chip and report.
    it("changes nothing about a failure nobody classified", () => {
        const crashed: AgentStanding = { status: `error`, attention: none };
        expect(laneOf(crashed)).toBe(`attention`);
        expect(blocked(crashed)).toBe(true);
        expect(attentionReason(crashed)).toBe(`Error`);
        expect(limitCountdown(crashed, NOW)).toBeUndefined();
    });
});

// The fourth fold of the two-level posture, same precedence as its three neighbours.
it(`effectiveLimitMove reads the conversation's override over the sandbox default`, () => {
    expect(effectiveLimitMove(undefined, undefined)).toBe(false);
    expect(effectiveLimitMove(undefined, true)).toBe(true);
    expect(effectiveLimitMove({ moveAfterLimit: false }, true)).toBe(false);
    expect(effectiveLimitMove({ moveAfterLimit: true }, false)).toBe(true);
});
