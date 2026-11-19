import type { HeldOf } from "../../agent/run/turn/holds/held-turn.js";
import type { HeldRecord } from "./conversation-state.js";
import { heldMoving, heldReopen, heldReopensAt, limitBooking, RESET_GRACE_MS, sendableAt } from "./limit-booking.js";

// The one rule a stranded card's lane and the resume pass both read: what a spent allowance's hold does by itself.

const RECORDED = 1_800_000_000_000;
const AHEAD = RECORDED / 1000 + 3_600;

// A spent allowance's hold; a booked move may be set, a person's pick (`onto`) is another test's.
const hold = (over: Partial<Omit<HeldOf<"limit">, "reason" | "onto">> & Partial<Pick<HeldRecord, "fired" | "reading">> = {}): HeldRecord => ({
    input: { conversationId: "c1", prompt: "p" },
    reason: "limit",
    ran: true,
    recordedAt: RECORDED,
    fired: false,
    tries: 0,
    reopensAt: AHEAD,
    ...over,
});

describe("when a spent allowance's hold goes at its reset", () => {
    // 2026-10-26 00:00:00: two Codex turns booked for that reset were refused within three seconds, the provider's
    // window not yet turned over; the same allowance served both a minute or two later.
    test("the grace after the reset it was booked for, in milliseconds", () => {
        expect(sendableAt(AHEAD)).toBe(AHEAD * 1000 + RESET_GRACE_MS);
        expect(heldReopensAt(hold())).toBe(sendableAt(AHEAD));
    });

    // A reset already past when the turn was refused would only be refused again, round and round.
    test("never at a reset whose grace was out when it was refused, nor with none", () => {
        expect(heldReopensAt(hold({ reopensAt: (RECORDED - RESET_GRACE_MS) / 1000 }))).toBeUndefined();
        expect(heldReopensAt(hold({ reopensAt: RECORDED / 1000 - 3_600 }))).toBeUndefined();
        expect(heldReopensAt({ recordedAt: RECORDED })).toBeUndefined();
    });

    // Refused inside the grace is the provider's clock behind its own reset: once more when the grace is out, and a
    // refusal then is recorded past it, so it never loops.
    test("once more at the grace's end when refused inside it", () => {
        const justReset = RECORDED / 1000 - 2;
        expect(heldReopensAt(hold({ reopensAt: justReset }))).toBe(sendableAt(justReset));
        expect(heldReopensAt({ reopensAt: justReset, recordedAt: sendableAt(justReset) })).toBeUndefined();
    });
});

describe("what a spent allowance's hold does by itself", () => {
    test("goes at its reset under any answer that sends, and waits for a press under `wait`", () => {
        expect(limitBooking(hold(), "resend")).toEqual({ at: sendableAt(AHEAD) });
        expect(limitBooking(hold(), "move")).toEqual({ at: sendableAt(AHEAD) });
        expect(limitBooking(hold(), "wait")).toBeUndefined();
    });

    test("moves at once while the answer is still to move, and waits for its reset once it is not", () => {
        const moving = hold({ move: { account: "acct-2", carry: false } });
        expect(limitBooking(moving, "move")).toEqual({ at: RECORDED, moving: "acct-2" });
        expect(limitBooking(moving, "resend")).toEqual({ at: sendableAt(AHEAD) });
    });

    // The cases that read "resends …" in Active while nothing would ever fire (2026-10-19): a hold with no instant (a
    // refusal that named none, a child past its horizon), one already fired, and a hold of another kind.
    test("does nothing by itself without an instant, once fired, or for another wall", () => {
        const { reopensAt: _none, ...untimed } = hold();
        expect(limitBooking(untimed, "resend")).toBeUndefined();
        expect(limitBooking(hold({ fired: true }), "resend")).toBeUndefined();
        const stopped: HeldRecord = { input: { conversationId: "c1", prompt: "p" }, reason: "stopped", ran: true, recordedAt: RECORDED, fired: false, tries: 0 };
        expect(limitBooking(stopped, "resend")).toBeUndefined();
        expect(limitBooking(undefined, "resend")).toBeUndefined();
    });
});

/* WHAT THE RESUME PASS READ OF THE RECORDS decides it once there is a reading (held-verdict.ts, `held-read`): the
   refusal's own instant is only the word a hold is judged on before any pass has read it. */
describe("a hold the pass has read", () => {
    const LATER = AHEAD + 7_200;

    test("goes at the instant its reading names, sooner or later than the refusal's, and not at all with none", () => {
        expect(limitBooking(hold({ reading: { at: sendableAt(LATER), reopensAt: LATER } }), "resend")).toEqual({ at: sendableAt(LATER) });
        expect(limitBooking(hold({ reading: { at: RECORDED + 5_000, reopensAt: RECORDED / 1000 - 55 } }), "resend")).toEqual({ at: RECORDED + 5_000 });
        expect(limitBooking(hold({ reading: {} }), "resend")).toBeUndefined();
    });

    // 2026-11-19: a booked move judged its account once, at the failure, and waited behind it once it was spent.
    test("moves onto the account the reading found with room, and waits on its own route where it found none", () => {
        const booked = { move: { account: "acct-2", carry: true } } as const;
        expect(limitBooking(hold({ ...booked, reading: { at: sendableAt(LATER), moveTo: "acct-3" } }), "move")).toEqual({ at: RECORDED, moving: "acct-3" });
        expect(limitBooking(hold({ ...booked, reading: { at: sendableAt(LATER) } }), "move")).toEqual({ at: sendableAt(LATER) });
        expect(heldMoving(hold({ ...booked, reading: { moveTo: "acct-3" } }))).toBe("acct-3");
        expect(heldMoving(hold({ ...booked, reading: {} }))).toBeUndefined();
        expect(heldMoving(hold(booked))).toBe("acct-2");
    });

    test("states the reopen its reading names, else the refusal's while unread", () => {
        expect(heldReopen(hold({ reading: { reopensAt: LATER } }))).toBe(LATER);
        expect(heldReopen(hold({ reading: {} }))).toBeUndefined();
        expect(heldReopen(hold())).toBe(AHEAD);
    });
});
