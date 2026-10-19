import type { HeldOf } from "../../agent/run/turn/holds/held-turn.js";
import type { HeldRecord } from "./conversation-state.js";
import { limitBooking, heldReopensAt } from "./limit-booking.js";

// The one rule a stranded card's lane and the resume pass both read: what a spent allowance's hold does by itself.

const RECORDED = 1_800_000_000_000;
const AHEAD = RECORDED / 1000 + 3_600;

// A spent allowance's hold; a booked move may be set, a person's pick (`onto`) is another test's.
const hold = (over: Partial<Omit<HeldOf<"limit">, "reason" | "onto">> & Partial<Pick<HeldRecord, "fired">> = {}): HeldRecord => ({
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
    test("at the reset it was booked for, in milliseconds", () => {
        expect(heldReopensAt(hold())).toBe(AHEAD * 1000);
    });

    // A reset already past when the turn was refused would only be refused again, round and round.
    test("never at a reset already past when it was refused, nor with none", () => {
        expect(heldReopensAt(hold({ reopensAt: RECORDED / 1000 - 1 }))).toBeUndefined();
        expect(heldReopensAt({ recordedAt: RECORDED })).toBeUndefined();
    });
});

describe("what a spent allowance's hold does by itself", () => {
    test("goes at its reset under any answer that sends, and waits for a press under `wait`", () => {
        expect(limitBooking(hold(), "resend")).toEqual({ at: AHEAD * 1000 });
        expect(limitBooking(hold(), "move")).toEqual({ at: AHEAD * 1000 });
        expect(limitBooking(hold(), "wait")).toBeUndefined();
    });

    test("moves at once while the answer is still to move, and waits for its reset once it is not", () => {
        const moving = hold({ move: { account: "acct-2", carry: false } });
        expect(limitBooking(moving, "move")).toEqual({ at: RECORDED, moving: "acct-2" });
        expect(limitBooking(moving, "resend")).toEqual({ at: AHEAD * 1000 });
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
