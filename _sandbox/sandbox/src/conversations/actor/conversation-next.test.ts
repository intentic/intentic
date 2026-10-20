import type { HeldOf } from "../../agent/run/turn/holds/held-turn.js";
import type { Ending } from "../registry/agents-store.js";
import { NO_QUEUE, type QueuedItem, removed, returned, scheduled, type TurnQueue } from "./conversation-queue.js";
import { nextOf, type WallAnswers } from "./conversation-next.js";
import { type HeldRecord, idleConversation } from "./conversation-state.js";

// WHAT CARRIES A CONVERSATION ON BY ITSELF is one value derived from what it holds (AgentSummary.next), which the lane,
// the card's corner, the chat and the phone all read. Each case below is a way the surfaces once disagreed because each
// rebuilt it from its own subset of the conversation's state.

const RECORDED = 1_800_000_000_000;
const RESET = RECORDED / 1000 + 3_600;
const SEND = { limit: "resend", memory: "resend" } as const satisfies WallAnswers;
const WAIT = { limit: "wait", memory: "wait" } as const satisfies WallAnswers;
const MEMORY: Ending = { kind: "failed", failure: "short of memory", code: "sandbox-memory-low" };
const LIMITED: Ending = { kind: "limited", failure: "spent", resetsAt: RESET, held: true };

const limitHold = (over: Partial<Omit<HeldOf<"limit">, "reason" | "onto">> & Partial<Pick<HeldRecord, "fired" | "walledUntil">> = {}): HeldRecord => ({
    input: { conversationId: "c1", prompt: "p" },
    reason: "limit",
    ran: true,
    recordedAt: RECORDED,
    fired: false,
    tries: 0,
    reopensAt: RESET,
    ...over,
});
const doorHold: HeldRecord = { input: { conversationId: "c1", prompt: "p" }, reason: "door", ran: false, recordedAt: RECORDED, fired: false, tries: 0 };

const words = (id: string, queuedAt = 1): Omit<QueuedItem, "revision"> => ({
    id,
    voice: "person",
    queuedAt,
    turn: { conversationId: "c1", prompt: `words ${id}`, agent: "claude" },
});

const holding = (queue: TurnQueue, held?: HeldRecord) => {
    const state = idleConversation(queue);
    return held === undefined ? state : { ...state, resume: { ...state.resume, held } };
};

describe("a spent allowance's held turn", () => {
    // amber-sable-9p, brisk-sage-gs1: "Send again" chosen, and the card's lane followed a copy of the booking that a
    // restart, a changed answer or a pick left stale. The answer is read now, every time.
    test("goes again at its reset only where the conversation's answer says so", () => {
        expect(nextOf(holding(NO_QUEUE, limitHold()), { ending: LIMITED }, SEND)).toEqual({ kind: "rerun", at: RESET * 1000 });
        expect(nextOf(holding(NO_QUEUE, limitHold()), { ending: LIMITED }, WAIT)).toBeUndefined();
    });

    test("moves at once while the answer is to move, naming where", () => {
        const moving = limitHold({ move: { account: "acct-2", carry: true } });
        expect(nextOf(holding(NO_QUEUE, moving), { ending: LIMITED }, { ...SEND, limit: "move" })).toEqual({ kind: "rerun", at: RECORDED, onto: "acct-2" });
        expect(nextOf(holding(NO_QUEUE, moving), { ending: LIMITED }, SEND)).toEqual({ kind: "rerun", at: RESET * 1000 });
    });

    // The wall the pass read in front of where it goes: the card says the instant the pass will fire at.
    test("waits behind the wall in front of where it goes, which never brings it earlier", () => {
        expect(nextOf(holding(NO_QUEUE, limitHold({ walledUntil: RESET * 1000 + 60_000 })), { ending: LIMITED }, SEND)).toEqual({ kind: "rerun", at: RESET * 1000 + 60_000 });
        expect(nextOf(holding(NO_QUEUE, limitHold({ walledUntil: RECORDED })), { ending: LIMITED }, SEND)).toEqual({ kind: "rerun", at: RESET * 1000 });
    });

    // A hold refused with no instant, one already fired, or dropped by a parent's cancel: nothing will send it.
    test("carries nothing on without an instant, once fired, or once dropped", () => {
        const { reopensAt: _none, ...untimed } = limitHold();
        expect(nextOf(holding(NO_QUEUE, untimed), { ending: LIMITED }, SEND)).toBeUndefined();
        expect(nextOf(holding(NO_QUEUE, limitHold({ fired: true })), { ending: LIMITED }, SEND)).toBeUndefined();
        expect(nextOf(holding(NO_QUEUE), { ending: LIMITED }, SEND)).toBeUndefined();
        expect(nextOf(undefined, { ending: LIMITED }, SEND)).toBeUndefined();
    });
});

describe("a message held because memory ran short", () => {
    // rich-birch-c96, spry-fjord-vy2, brisk-sage-gs1: the memory hold goes by itself under the answer to send when room
    // comes back, as a spent allowance's resend does, so it is carried on, not left in Attention under a corner saying so.
    test("goes once memory frees where the answer is to send it then, and waits for a press otherwise", () => {
        const refused = returned(NO_QUEUE, [words("m1")]);
        expect(nextOf(holding(refused), { ending: MEMORY }, SEND)).toEqual({ kind: "room" });
        expect(nextOf(holding(refused), { ending: MEMORY }, WAIT)).toBeUndefined();
    });

    test("covers a turn the sandbox kept at the door, and nothing a refusal of another kind holds", () => {
        expect(nextOf(holding(NO_QUEUE, doorHold), { ending: MEMORY }, SEND)).toEqual({ kind: "room" });
        expect(nextOf(holding(NO_QUEUE, doorHold), { ending: { kind: "failed", code: "agent-domain-refused" } }, SEND)).toBeUndefined();
        expect(nextOf(holding(returned(NO_QUEUE, [words("m1")])), { ending: { kind: "failed", code: "agent-domain-refused" } }, SEND)).toBeUndefined();
    });
});

describe("messages a person booked for later", () => {
    // lucid-basin-6j: each message keeps its own time, and the soonest speaks for the card.
    test("goes at the soonest booking, counting every message booked", () => {
        const two = scheduled(scheduled(NO_QUEUE, words("late"), { until: 9_000_000 }), words("soon"), { until: 5_000_000 });
        expect(nextOf(holding(two), { ending: { kind: "idle" } }, WAIT)).toEqual({ kind: "send", at: 5_000_000, count: 2 });
        const onLand = scheduled(NO_QUEUE, words("after"), { after: { conversationId: "brave-otter", since: 1 } });
        expect(nextOf(holding(onLand), { ending: { kind: "idle" } }, WAIT)).toEqual({ kind: "land", after: "brave-otter", count: 1 });
    });

    // A booking is the person's answer to a dead end (solid-otter-ulbz): it carries the conversation on beside a Stop's
    // hold on the unbooked words, whatever the answers to the walls.
    test("carries it on beside a hold on the words nothing booked", () => {
        const stopped = { ...returned(NO_QUEUE, [words("held")]), paused: "stopped" as const };
        const both = scheduled(stopped, words("later"), { until: 5_000_000 });
        expect(nextOf(holding(both), { ending: { kind: "stopped" } }, WAIT)).toEqual({ kind: "send", at: 5_000_000, count: 1 });
    });

    // rich-cove-yipt, sharp-heron-6n: the booking taken back leaves nothing that would carry the conversation on.
    test("carries nothing on once its only booking is taken back", () => {
        const booked = scheduled(NO_QUEUE, words("only"), { until: 5_000_000 });
        const item = booked.items[0];
        if (item === undefined) {
            throw new Error("expected a booking");
        }
        expect(nextOf(holding(removed(booked, item.id, item.revision).queue), { ending: { kind: "idle" } }, SEND)).toBeUndefined();
    });
});

// A conversation no actor holds yet (an arrival just brought it) holds no turn: the bookings its entry kept still speak.
test("reads the entry's bookings for a conversation no actor holds yet", () => {
    const booked = scheduled(NO_QUEUE, words("later"), { until: 5_000_000 });
    expect(nextOf(undefined, { ending: LIMITED, queue: booked }, SEND)).toEqual({ kind: "send", at: 5_000_000, count: 1 });
});

// A card goes one way first: the held turn the ending stopped, then its memory hold, then what was booked after it.
test("reads the held turn first, then a memory hold, then the soonest booking", () => {
    const booked = scheduled(NO_QUEUE, words("later"), { until: 5_000_000 });
    expect(nextOf(holding(booked, limitHold()), { ending: LIMITED }, SEND)).toEqual({ kind: "rerun", at: RESET * 1000 });
    expect(nextOf(holding(booked, limitHold()), { ending: LIMITED }, WAIT)).toEqual({ kind: "send", at: 5_000_000, count: 1 });
    const memory = scheduled(returned(NO_QUEUE, [words("held")]), words("later"), { until: 5_000_000 });
    expect(nextOf(holding(memory), { ending: MEMORY }, SEND)).toEqual({ kind: "room" });
    expect(nextOf(holding(memory), { ending: MEMORY }, WAIT)).toEqual({ kind: "send", at: 5_000_000, count: 1 });
});
