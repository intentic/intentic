import type { AgentStatus, AgentWatch } from "@intentic/sandbox-contract";
import {
    type AgentStanding,
    agentStandingMeta,
    agentStatusMeta,
    attentionCalls,
    attentionCards,
    attentionReason,
    awaitingUser,
    blocked,
    callsOwner,
    heardByParent,
    type ClientAgentStatus,
    conflictIsYours,
    drillTarget,
    landedAway,
    landFailure,
    laneOf,
    standingFrom,
    limitBack,
    limitCorner,
    limitCountdown,
    limitGroups,
    memoryHeld,
    onlyOwnerCanAnswer,
    type RimAgent,
    reviewAction,
    tileRim,
    turnInFlight,
    unfinishedMark,
    unregistered,
    watchLine,
    watching,
} from "../agentStatus";

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
    // A land spends no model, so it never reaches Active: the card is pressed in Finished and stays there, drawing its
    // progress in place. The daemon still holds the worktree exactly as a turn would, so every hands-off guard reads it
    // as in flight and nothing offers a press the daemon would refuse.
    it("keeps a landing card in Finished, in flight for every guard", () => {
        expect(laneOf({ status: `landing`, attention: none })).toBe(`finished`);
        expect(laneOf({ status: `ready`, attention: none })).toBe(`finished`);
        expect(turnInFlight({ status: `landing`, attention: none })).toBe(true);
        expect(agentStatusMeta(`landing`).label).toBe(`Landing…`);
    });

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
    // The daemon reads an armed watch as a wake to come, and says so (awaitingWake).
    it("keeps an idle agent with an armed watch in active: it will run again by itself", () => {
        expect(laneOf({ status: `idle`, attention: none, watches: [watch()], awaitingWake: true })).toBe(`active`);
        expect(laneOf({ status: `landed`, attention: none, watches: [watch()], awaitingWake: true })).toBe(`active`);
    });

    // The daemon's own reading decides where it says: a wake waiting in the queue keeps a card active with no watch at
    // all, and a daemon that says nothing wakes it is not second-guessed from the list it still shows.
    it("reads the daemon's awaitingWake before its watch list", () => {
        expect(laneOf({ status: `idle`, attention: none, awaitingWake: true })).toBe(`active`);
        expect(laneOf({ status: `idle`, attention: none, awaitingWake: false, watches: [watch()] })).toBe(`finished`);
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
        const waiting = unfinishedMark({ status: `idle`, attention: none, watches: [watch()], awaitingWake: true });
        const working = unfinishedMark({ status: `running`, attention: none, watches: [watch()], awaitingWake: true });
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

    // "Land conflict" beside a press only the reader can make reads as the agent's problem, so the chip names whose
    // problem it is. Same width budget as every other chip, and only when every cause left is the reader's own.
    it("names a refusal the reader has to clear as theirs, not as the agent's", () => {
        const mine: AgentStanding = { status: `conflict`, attention: none, conflictCauses: [`workspace`] };
        expect(attentionReason(mine)).toBe(`Your edits`);
        // No wider than the word it replaces: the chip is shrink-0 beside a title that isn't.
        const generic = attentionReason({ status: `conflict`, attention: none }) ?? ``;
        expect(attentionReason(mine)?.length).toBeLessThanOrEqual(generic.length);
        expect(conflictIsYours(mine)).toBe(true);
    });

    // Anything the agent can still rebase keeps the generic word: its press is the one on offer, and a chip promising
    // the reader work they needn't do is as wrong as one hiding work they must.
    it("keeps the agent's word while any cause is the agent's, and for a refusal with no causes named", () => {
        const mixed: AgentStanding = { status: `conflict`, attention: none, conflictCauses: [`workspace`, `diverged`] };
        expect(attentionReason(mixed)).toBe(`Land conflict`);
        expect(conflictIsYours(mixed)).toBe(false);
        // No causes at all is a daemon that could not attribute the refusal; the board falls back as it always did.
        expect(attentionReason({ status: `conflict`, attention: none })).toBe(`Land conflict`);
        expect(conflictIsYours({ status: `conflict`, attention: none, conflictCauses: [] })).toBe(false);
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

    // The hint carries what the line can't: every note in full with its pacing, and that the end of the wait is the
    // agent working again, not a notification, which is what decides whether a user leaves it armed.
    it("spells the pacing, every note in full, and what happens when it ends", () => {
        const first = watch();
        const second = watch({ id: `watch-2`, note: `deploy` });
        const hint = watchLine({ status: `idle`, attention: none, watches: [first, second] }, NOW)?.hint;
        expect(hint?.rows?.map((row) => row.label)).toEqual([first.note, second.note]);
        expect(hint?.rows?.[0]?.value).toContain(`60s`);
        expect(hint?.note).toBe(`First one wakes it`);
    });

    // One watch: its note is the line itself, so the card is just the pacing and the deadline.
    it("gives one watch its pacing and deadline as two rows, and says it wakes the chat", () => {
        expect(watchLine({ status: `idle`, attention: none, watches: [watch()] }, NOW)?.hint).toEqual({
            title: `Watching`,
            tone: `info`,
            rows: [
                { label: `Checks every`, value: `60s` },
                { label: `Gives up in`, value: `42m 0s` },
            ],
            note: `Wakes this chat`,
        });
    });

    // Pacing in the fewest characters that stay true: a half-hourly check reads as minutes, not seconds.
    it("says a slow cadence in minutes", () => {
        expect(watchLine({ status: `idle`, attention: none, watches: [watch({ intervalSeconds: 1800 })] }, NOW)?.hint.rows?.[0]?.value).toBe(`30m`);
    });
});

// A spent allowance arrives as `status: "error"` and is a wait rather than a fault, a stall the reader is shown until
// something is booked to carry it on.
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

    // Booked to go again at the reset, nothing is owed: counted as a call, it held the badge and the tab title up for
    // hours over a question the reader had already answered. Active, as an armed watch is, and the card keeps its
    // "Usage limit" chip, so the stall is still in sight.
    it("leaves attention once a resend is booked at the reset", () => {
        const booked = { status: `error`, attention: none, ...SHUT, limitScheduled: true } as const;
        expect(blocked(booked)).toBe(false);
        expect(laneOf(booked)).toBe(`active`);
        expect(unfinishedMark(booked)?.label).toBe(`Resend booked`);
        expect(attentionReason(booked)).toBe(`Usage limit`);
        expect(laneOf({ ...booked, awaitingWake: true })).toBe(`active`);
        // Unbooked, the same card is the reader's again.
        expect(laneOf({ ...booked, limitScheduled: false })).toBe(`attention`);
    });

    // The one spent allowance already under way: the policy is carrying the held turn to another account on the resume
    // pass's next beat, seconds out, so filing it in Attention would flash a card nobody needs to touch.
    it("leaves attention only while a move to another account is booked", () => {
        const moving = { status: `error`, attention: none, ...SHUT, limitScheduled: true, limitMoving: `Work` } as const;
        expect(blocked(moving)).toBe(false);
        expect(laneOf(moving)).toBe(`active`);
        expect(unfinishedMark(moving)?.label).toBe(`Moving to Work`);
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
    // pool measured in hours is arithmetic, not information. Whole minutes rounded up, never seconds: the instant is
    // the provider's guess, and "26m 26s" ticking on a card claimed a precision nobody had.
    it("counts down in whole minutes while that is a wait, and names the instant once it is not", () => {
        const at = NOW + 39 * 60 * 1000 + 20_000;
        expect(limitCountdown({ status: `error`, attention: none, failureCode: `rate_limit`, limitResetsAt: at / 1000 }, NOW)).toEqual({
            at,
            text: `40m`,
            wait: true,
        });
        // Seconds from the reset still read as a minute, never "0m".
        expect(limitCountdown({ status: `error`, attention: none, failureCode: `rate_limit`, limitResetsAt: (NOW + 5_000) / 1000 }, NOW)?.text).toBe(
            `1m`,
        );
        // Four hours out: a clock time, not a count. The exact string is the locale's; this pins the shape.
        const far = limitCountdown({ status: `error`, attention: none, ...SHUT }, NOW);
        expect(far?.wait).toBe(false);
        expect(far?.text).toMatch(/\d{2}:\d{2}/u);
    });

    // A wait takes "in", an instant stands bare: "back 26m 26s" read as a sentence missing its word.
    it("says a wait with its preposition and an instant without one", () => {
        expect(limitBack({ at: NOW, text: `40m`, wait: true })).toBe(`back in 40m`);
        expect(limitBack({ at: NOW, text: `Thu 14:05`, wait: false })).toBe(`back Thu 14:05`);
    });

    // The card's corner for each shape of the wait. Booked, it says what goes by itself and when, which is why a card
    // that isn't running rests in Active; a booked move goes on the resume pass's next beat whatever the refused
    // account's reset says, so it names where, not when.
    it("names what goes by itself, and when, in the card's corner", () => {
        const soon = { status: `error`, attention: none, failureCode: `rate_limit`, limitResetsAt: (NOW + 40 * 60 * 1000) / 1000 } as const;
        expect(limitCorner(soon, NOW)?.text).toBe(`back in 40m`);
        expect(limitCorner({ ...soon, limitScheduled: true }, NOW)?.text).toBe(`resends in 40m`);
        expect(limitCorner({ status: `error`, attention: none, ...SHUT, limitScheduled: true }, NOW)?.text).toMatch(
            /^resends (?:\S.* )?\d{2}:\d{2}$/u,
        );
        // Past its instant a booked resend goes on the pass's next beat: said so, not dropped for a date that makes a
        // card resting in Active look stuck.
        expect(limitCorner({ status: `error`, attention: none, ...OPEN, limitScheduled: true }, NOW)?.text).toBe(`resends in a moment`);
        expect(limitCorner({ ...soon, limitScheduled: true, limitMoving: `Work` }, NOW)).toEqual({
            kind: `moving`,
            account: `Work`,
            text: `moving to Work`,
        });
    });

    // Nothing booked and the window open: the corner is the ordinary date's again. And a real failure never gets one.
    it("leaves the corner to the date once nothing is waited on", () => {
        expect(limitCorner({ status: `error`, attention: none, ...OPEN }, NOW)).toBeUndefined();
        expect(limitCorner({ status: `error`, attention: none }, NOW)).toBeUndefined();
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

// The same two-level fold for what happens when a turn breaks now lives in chat/run/turnBreak.ts, one question per
// ending rather than a boolean per switch; turnBreak.test.ts covers its precedence.

// The identity tile's rim: which of the two readings it draws, how far round, and in what ink. One function, because
// the board card and the rail card render from it and may not disagree.
describe(`tileRim`, () => {
    const at = (over: Partial<RimAgent> = {}): RimAgent => ({ status: `idle`, attention: none, ...over });
    // A window and a fill that divide to exactly 61%, so the assertions can state the percentage.
    const context = { contextTokens: 122_000, contextWindow: 200_000 };

    it(`draws the context arc for a session that kept no list`, () => {
        expect(tileRim(at(context), { quiet: false })).toEqual({
            kind: `context`,
            percent: 61,
            tone: `text-primary-500`,
            hint: `61% of context used`,
        });
    });

    it(`draws nothing at all when neither reading exists`, () => {
        expect(tileRim(at(), { quiet: false })).toBeUndefined();
    });

    // 80 is the band's own edge, not a value near it: at exactly 80 the rim is already amber.
    it(`turns the context arc amber from 80% up, and quiet ink outranks both`, () => {
        expect(tileRim(at({ contextTokens: 79, contextWindow: 100 }), { quiet: false })?.tone).toBe(`text-primary-500`);
        expect(tileRim(at({ contextTokens: 80, contextWindow: 100 }), { quiet: false })?.tone).toBe(`text-warning`);
        expect(tileRim(at({ contextTokens: 95, contextWindow: 100 }), { quiet: true })?.tone).toBe(`text-subtle`);
    });

    // THE RIM'S RULE: a checklist takes it whenever there is one, and the context reading rides the hover instead.
    it(`gives the rim to the checklist and keeps context in the hover`, () => {
        expect(tileRim(at({ ...context, checklist: { done: 1, total: 4 } }), { quiet: false })).toEqual({
            kind: `steps`,
            segments: 5,
            filled: 1,
            tone: `text-primary-500`,
            hint: `1 of 4 steps done · 61% of context used`,
        });
    });

    it(`names the steps alone when nothing measured the window`, () => {
        expect(tileRim(at({ checklist: { done: 1, total: 1 } }), { quiet: false })?.hint).toBe(`1 of 1 step done`);
    });

    // ITEMS PLUS ONE, AND THE LAST IS THE TURN'S OWN ENDING. A list emptied by a turn still running leaves one segment
    // bare; only the settled card closes the ring.
    it(`holds the last segment back until the turn settles`, () => {
        const whole = { checklist: { done: 3, total: 3 } };
        expect(tileRim(at({ ...whole, status: `running` }), { quiet: false })).toMatchObject({ segments: 4, filled: 3 });
        expect(tileRim(at({ ...whole, status: `idle` }), { quiet: false })).toMatchObject({ segments: 4, filled: 4 });
    });

    // A land spends no model and has no list left to move, so it counts as settled here exactly as it does for the
    // card's elapsed clock (turnWorking).
    it(`counts a landing card as settled`, () => {
        expect(tileRim(at({ checklist: { done: 2, total: 2 }, status: `landing` }), { quiet: false })).toMatchObject({ segments: 3, filled: 3 });
    });

    // A partly-done list on a card at rest is the commonest reading on the board, and it must not round up to whole.
    it(`leaves a rested but unfinished list short of its last two segments`, () => {
        expect(tileRim(at({ checklist: { done: 2, total: 3 } }), { quiet: false })).toMatchObject({ segments: 4, filled: 2 });
    });

    // The daemon promises done <= total; a frame that broke it would otherwise light more segments than exist.
    it(`cannot light more segments than the list has`, () => {
        expect(tileRim(at({ checklist: { done: 9, total: 3 } }), { quiet: false })).toMatchObject({
            segments: 4,
            filled: 4,
            hint: `3 of 3 steps done`,
        });
    });
});

// A child agent's stop is its parent's news while the parent supervises; only what the owner alone can answer reaches
// the reader whatever the parent does.
describe("what a child agent asks of the reader", () => {
    const standing = (over: Partial<AgentStanding> = {}): AgentStanding => ({ status: `idle`, attention: none, ...over });

    it("names the asks only the owner can answer, and leaves a question to the parent", () => {
        expect(onlyOwnerCanAnswer(standing({ status: `awaiting`, attention: { ...none, permission: true } }))).toBe(true);
        expect(onlyOwnerCanAnswer(standing({ status: `awaiting`, attention: { ...none, plan: true } }))).toBe(true);
        expect(onlyOwnerCanAnswer(standing({ status: `awaiting` }))).toBe(true);
        expect(onlyOwnerCanAnswer(standing({ status: `conflict`, attention: { ...none, conflict: true }, conflictCauses: [`workspace`] }))).toBe(
            true,
        );
        expect(onlyOwnerCanAnswer(standing({ status: `awaiting`, attention: { ...none, question: true } }))).toBe(false);
        expect(onlyOwnerCanAnswer(standing({ status: `error`, failureCode: `rate_limit` }))).toBe(false);
    });

    it("hands a stop to the reader only once its parent stops supervising", () => {
        const spent = { ...standing({ status: `error`, failureCode: `rate_limit` }), updatedAt: 2_000 };
        expect(callsOwner(spent, { child: `attention`, parent: `active`, parentAt: 1_000 })).toBe(false);
        expect(callsOwner(spent, { child: `attention`, parent: `finished`, parentAt: 1_000 })).toBe(true);
        expect(callsOwner(spent, { child: `attention`, parent: `attention`, parentAt: 1_000 })).toBe(true);
    });

    // Every ending of a child's turn is reported to its parent, so a parent that ran or landed after the stop heard it,
    // and its own ending is the account the reader gets: an orchestrator that landed is done, not stuck.
    it("stops handing a turn's ending to the reader once the parent has moved past it", () => {
        const at = (over: Partial<AgentStanding>) => ({ ...standing(over), updatedAt: 1_000 });
        for (const ended of [
            at({ status: `error`, failureCode: `rate_limit` }),
            at({ status: `error` }),
            at({ status: `stopped` }),
            at({ status: `interrupted` }),
        ]) {
            expect(heardByParent(ended, 2_000)).toBe(true);
            expect(callsOwner(ended, { child: `attention`, parent: `finished`, parentAt: 2_000 })).toBe(false);
            // The same instant is no proof the parent was told.
            expect(heardByParent(ended, 1_000)).toBe(false);
        }
    });

    it("keeps calling for what no report settles, however far the parent has moved", () => {
        const at = (over: Partial<AgentStanding>) => ({ ...standing(over), updatedAt: 1_000 });
        const family = { child: `attention`, parent: `finished`, parentAt: 9_000 } as const;
        // A question still parked waits for an answer, and a refused or broken land leaves work stuck on the branch.
        expect(callsOwner(at({ status: `awaiting`, attention: { ...none, question: true } }), family)).toBe(true);
        expect(callsOwner(at({ status: `conflict`, attention: { ...none, conflict: true }, conflictCauses: [`diverged`] }), family)).toBe(true);
        expect(callsOwner(at({ status: `error`, landFailure: { reason: `fatal: refused`, at: 1_000 } }), family)).toBe(true);
        // What only the owner can answer, whatever the parent did.
        expect(callsOwner(at({ status: `awaiting`, attention: { ...none, permission: true } }), family)).toBe(true);
        // Not yet an ending anyone was told, and a pause booked to run again is not over.
        expect(heardByParent(at({ status: `stopping` }), 9_000)).toBe(false);
        expect(heardByParent(at({ status: `error`, failureCode: `rate_limit`, limitScheduled: true }), 9_000)).toBe(false);
    });
});

// The rail badge names the Attention lane as the board draws it, children folded under their parents.
describe("attentionCards", () => {
    const agent = (id: string, over: Partial<AgentStanding> & { startedBy?: string; unsent?: boolean; updatedAt?: number } = {}) => ({
        id,
        status: `landed` as AgentStatus,
        attention: none,
        updatedAt: 0,
        ...over,
    });
    const child = (id: string, parent: string, over: Partial<AgentStanding> & { unsent?: boolean; updatedAt?: number } = {}) =>
        agent(id, { startedBy: `agent:${parent}`, ...over });
    const spent = { status: `error`, failureCode: `rate_limit` } as const;

    it("counts nothing for children stopped under a parent still at work, however many", () => {
        const fleet = [agent(`p`, { status: `running` }), ...Array.from({ length: 15 }, (_unused, index) => child(`c${index}`, `p`, spent))];
        expect(attentionCards(fleet)).toBe(0);
    });

    it("counts a family once however many of its children ask what only the reader can give", () => {
        const fleet = [
            agent(`p`, { status: `running` }),
            child(`a`, `p`, { status: `awaiting`, attention: { ...none, permission: true } }),
            child(`b`, `p`, { status: `awaiting`, attention: { ...none, plan: true } }),
            child(`g`, `a`, { status: `awaiting`, attention: { ...none, capability: true } }),
        ];
        expect(attentionCards(fleet)).toBe(1);
    });

    it("counts a stopped parent's stuck children as its one card, and not again for its own stop", () => {
        expect(attentionCards([agent(`p`, spent), child(`a`, `p`, spent), child(`b`, `p`, { status: `stopped` })])).toBe(1);
        expect(attentionCards([agent(`p`), child(`a`, `p`, spent)])).toBe(1);
    });

    it("counts nothing for a finished parent that moved past its children's stops: it heard them, and landed anyway", () => {
        const landed = agent(`p`, { updatedAt: 9_000 });
        expect(
            attentionCards([landed, child(`a`, `p`, { ...spent, updatedAt: 1_000 }), child(`b`, `p`, { status: `error`, updatedAt: 1_000 })]),
        ).toBe(0);
        // A stop after the parent's last move is news nobody has had.
        expect(attentionCards([landed, child(`late`, `p`, { ...spent, updatedAt: 9_500 })])).toBe(1);
    });

    it("counts a child as a card of its own when its parent is not here, or its composer holds words", () => {
        expect(attentionCards([child(`orphan`, `gone`, spent), agent(`else`, { status: `awaiting` }), agent(`done`)])).toBe(2);
        expect(attentionCards([agent(`p`, { status: `running` }), child(`words`, `p`, { ...spent, unsent: true })])).toBe(1);
    });
    // The browser tab rings for a new caller, so it reads the callers the count folds away: a second child asking
    // under a family already in Attention moves no count but is news.
    it("names every caller with the card it rides, which the count folds to one", () => {
        const fleet = [
            agent(`p`, { status: `running` }),
            child(`a`, `p`, { status: `awaiting`, attention: { ...none, permission: true } }),
            child(`g`, `a`, { status: `awaiting`, attention: { ...none, capability: true } }),
            child(`quiet`, `p`, spent),
            agent(`solo`, { status: `awaiting` }),
        ];
        expect(attentionCalls(fleet)).toEqual([
            { id: `a`, card: `p` },
            { id: `g`, card: `p` },
            { id: `solo`, card: `solo` },
        ]);
        expect(attentionCards(fleet)).toBe(2);
    });
});

// A land git refused is its own ending: the card says it could not land, in plain words, and never reads as finished.
describe("a land that broke", () => {
    const broke = (failure: string): AgentStanding => ({ status: `error`, attention: none, failure });

    it("names a checkout that lost its history instead of quoting git", () => {
        const card = broke(
            `Command failed: git --no-optional-locks -C /work/tabularium diff --output=/tmp/x c011c54 3e03077 fatal: bad object 3e03077`,
        );
        expect(landFailure(card)).toBe(`this agent's copy lost its link to your workspace's history`);
        expect(attentionReason(card)).toBe(`Couldn't land`);
        expect(laneOf(card)).toBe(`attention`);
    });

    it("falls back to git's own last line, and to a plain sentence when git said nothing", () => {
        expect(landFailure(broke(`Command failed: git apply --check x.patch fatal: corrupt patch at line 12`))).toBe(`corrupt patch at line 12`);
        expect(landFailure(broke(`Command failed: git apply --check x.patch`))).toBe(`git refused to carry its work into your files`);
    });

    // The sandbox keeps a broken land on the card until one goes through: the next turn clears the turn's failure, and the
    // card used to go back to Finished with a check mark while the work stayed stuck.
    it("stands on a card whose turn since ended cleanly, in plain words, until a turn or land is under way", () => {
        const lost: AgentStanding = {
            status: `ready`,
            attention: none,
            landFailure: { reason: `This agent's copy of the workspace lost its link`, code: `unlinked`, at: 1 },
        };
        expect(landFailure(lost)).toBe(`this agent's copy lost its link to your workspace's history`);
        expect(attentionReason(lost)).toBe(`Couldn't land`);
        expect(laneOf(lost)).toBe(`attention`);
        expect(laneOf({ ...lost, status: `landed` })).toBe(`attention`);
        // Git's own words go through the same reading as a turn's; anything else is said as it came.
        expect(landFailure({ ...lost, landFailure: { reason: `Command failed: git apply x.patch fatal: corrupt patch at line 3`, at: 1 } })).toBe(
            `corrupt patch at line 3`,
        );
        expect(landFailure({ ...lost, landFailure: { reason: `ENOSPC: no space left on device`, at: 1 } })).toBe(`ENOSPC: no space left on device`);
        // A turn or a land under way ends in a land of its own: nothing to say until it does.
        expect(landFailure({ ...lost, status: `running` })).toBeUndefined();
        expect(laneOf({ ...lost, status: `running` })).toBe(`active`);
        expect(landFailure({ ...lost, status: `landing` })).toBeUndefined();
        expect(laneOf({ ...lost, status: `landing` })).toBe(`finished`);
        expect(standingFrom(lost).landFailure).toEqual(lost.landFailure);
    });

    it("leaves every other failure, and a spent allowance, to read as it did", () => {
        expect(landFailure(broke(`The model is overloaded.`))).toBeUndefined();
        expect(attentionReason(broke(`The model is overloaded.`))).toBe(`Error`);
        expect(landFailure({ status: `idle`, attention: none, failure: `Command failed: git diff fatal: bad object 1` })).toBeUndefined();
        expect(landFailure({ status: `error`, attention: none, failureCode: `rate_limit`, failure: `Command failed: git x` })).toBeUndefined();
    });
});

// The drill-in goes where its label says: an ask answered on its card leads to the chat, never the review page.
describe("drillTarget", () => {
    it("sends every ask answered in the chat, and a spent allowance, to the chat", () => {
        for (const park of [`plan`, `question`, `permission`, `capability`, `credential`, `need`] as const) {
            expect(drillTarget({ status: `awaiting`, attention: { ...none, [park]: true } })).toBe(`chat`);
        }
        expect(drillTarget({ status: `awaiting`, attention: none })).toBe(`chat`);
        expect(drillTarget({ status: `error`, attention: none, failureCode: `rate_limit` })).toBe(`chat`);
    });

    it("keeps a refused land, an error and a finished diff on the review page", () => {
        expect(drillTarget({ status: `conflict`, attention: { ...none, conflict: true } })).toBe(`review`);
        expect(drillTarget({ status: `error`, attention: none })).toBe(`review`);
        expect(drillTarget({ status: `landed`, attention: none })).toBe(`review`);
    });

    it("agrees with the label: an Approve leads to the chat", () => {
        const asking = { status: `awaiting` as const, attention: { ...none, permission: true }, branch: `agent/x` };
        expect([reviewAction(asking), drillTarget(asking)]).toEqual([`Approve`, `chat`]);
        // A bare park on a browser or terminal hand-off: named for the chat it opens, not "Review".
        const parked = { status: `awaiting` as const, attention: none, branch: `agent/x` };
        expect([reviewAction(parked), drillTarget(parked)]).toEqual([`Open chat`, `chat`]);
    });
});

describe("landedAway", () => {
    it("says the files may have been taken out on purpose, by the reader or another agent", () => {
        const away = landedAway({ landedPresence: { landed: 4, present: 0 } });
        expect(away?.offerReland).toBe(true);
        expect(away?.tip).toEqual({
            title: `Removed after it landed`,
            rows: [{ label: `In workspace`, value: `0/4` }],
            note: `Still on its branch. Taken out after it landed, by you or by another agent tidying up: Land again only if you want them back.`,
        });
        expect(landedAway({ landedPresence: { landed: 4, present: 1 } })?.tip.note).toBe(
            `Rest on its branch. Taken out after it landed, by you or by another agent tidying up: Land again only if you want them back.`,
        );
    });
});

// Who took it out, when the sandbox could tell: an agent's own tidying offers no Land again, a person's does.
describe("landedAway, named", () => {
    const took = (removedBy: NonNullable<Parameters<typeof landedAway>[0]["landedPresence"]>["removedBy"], present = 0) =>
        landedAway({ landedPresence: { landed: 4, present, removedBy } }, `me@example.com`);

    it("names the agent that took them out, and offers nothing to put them back", () => {
        const away = took({ kind: `agent`, id: `orch`, title: `Orchestrator` });
        expect(away?.text).toBe(`Removed by Orchestrator`);
        expect(away?.offerReland).toBe(false);
        expect(away?.tip.note).toBe(`Still on its branch. Orchestrator took them out after it landed, so this card doesn't offer to put them back.`);
        expect(took({ kind: `agent`, id: `gone` })?.text).toBe(`Removed by another agent`);
        expect(took({ kind: `agent`, id: `orch`, title: `Orchestrator` }, 1)).toMatchObject({ text: `1/4`, offerReland: false });
    });

    it("names the reader as you, another person by name, and an unnamed discard by where it happened; each offers Land again", () => {
        expect(took({ kind: `person`, email: `me@example.com` })).toMatchObject({ text: `Removed by you`, offerReland: true });
        expect(took({ kind: `person`, email: `me@example.com` })?.tip.note).toBe(`Still on its branch. You took them out after it landed.`);
        expect(took({ kind: `person`, email: `ana@example.com`, name: `Ana` })).toMatchObject({ text: `Removed by Ana`, offerReland: true });
        expect(took({ kind: `person` })).toMatchObject({ text: `Removed`, offerReland: true });
        expect(took({ kind: `person` })?.tip.note).toBe(`Still on its branch. Thrown away in the Changes panel after it landed.`);
    });
});

// One press for the agents a provider's limit stopped together.
describe("limitGroups", () => {
    const stopped = (id: string, over: Partial<AgentStanding> & { provider?: `claude` | `zai` } = {}) => ({
        id,
        provider: `zai` as const,
        status: `error` as const,
        attention: none,
        failureCode: `rate_limit`,
        limitHeld: true,
        ...over,
    });

    it("gathers two or more held turns of one provider, and books them when every reset is known and ahead", () => {
        const at = (minutes: number): number => Math.round((NOW + minutes * 60_000) / 1_000);
        expect(limitGroups([stopped(`a`, { limitResetsAt: at(10) }), stopped(`b`, { limitResetsAt: at(40) })], NOW)).toEqual([
            { provider: `zai`, ids: [`a`, `b`], reopensAt: at(40) * 1_000 },
        ]);
    });

    it("sends them now when any reset is unknown or already past", () => {
        expect(limitGroups([stopped(`a`), stopped(`b`, { limitResetsAt: Math.round(NOW / 1_000) + 600 })], NOW)).toEqual([
            { provider: `zai`, ids: [`a`, `b`] },
        ]);
        expect(limitGroups([stopped(`a`, { limitResetsAt: Math.round(NOW / 1_000) - 1 }), stopped(`b`)], NOW)).toEqual([
            { provider: `zai`, ids: [`a`, `b`] },
        ]);
    });

    it("leaves out a lone card, another provider, a booked resend, a turn not held, and another box's card", () => {
        expect(
            limitGroups(
                [
                    stopped(`a`),
                    stopped(`b`, { provider: `claude` }),
                    stopped(`c`, { limitScheduled: true }),
                    stopped(`d`, { limitHeld: false }),
                    { ...stopped(`e`), sandboxId: `box-2` },
                ],
                NOW,
            ),
        ).toEqual([]);
    });
});

// A message held because the sandbox ran short of memory reached the board as a red "Error" with the daemon's English
// sentence, and was rage-clicked: it is a hold waiting on "send anyway", in Attention, worded and tinted as held.
describe("a message held for low memory", () => {
    const held: AgentStanding = {
        status: `error`,
        attention: none,
        failureCode: `sandbox-memory-low`,
        failure: `Sandbox memory is low: 4.9 GiB resident`,
    };

    it("reads as held, not as an error, and still asks the reader in Attention", () => {
        expect(memoryHeld(held)).toBe(true);
        expect(attentionReason(held)).toBe(`Held`);
        expect(agentStandingMeta(held)).toEqual({ icon: `pause`, label: `Held: sandbox memory is low`, class: `text-warning` });
        expect(reviewAction({ ...held, branch: `agent/x` })).toBe(`Open chat`);
        // ...and the label's promise is kept: "send anyway" is in the chat, which the review page does not draw.
        expect(drillTarget(held)).toBe(`chat`);
        expect(laneOf(held)).toBe(`attention`);
    });

    it("leaves every other error, and a card that is not an error, as it was", () => {
        const broken: AgentStanding = { status: `error`, attention: none, failureCode: `harness-crash` };
        expect(memoryHeld(broken)).toBe(false);
        expect(attentionReason(broken)).toBe(`Error`);
        expect(agentStandingMeta(broken)).toEqual(agentStatusMeta(`error`));
        expect(memoryHeld({ status: `idle`, failureCode: `sandbox-memory-low` })).toBe(false);
    });
});
