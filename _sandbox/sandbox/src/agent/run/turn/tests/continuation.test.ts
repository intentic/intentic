import { scheduledContinueRow } from "../continuation.js";

// Three Continues booked two days earlier went out at a boot and failed, with nothing saying they had been scheduled
// (2026-11-09): the turn a waiting continuation starts now opens on a row that does.
test("a Continue that waited in the queue says it was scheduled, and how long ago", () => {
    expect(scheduledContinueRow(41 * 3_600_000 + 3 * 60_000)).toEqual({
        role: "notice",
        text: "A Continue scheduled 41h 3m ago went out by itself.",
        noticeCode: { code: "scheduledContinue", params: { waited: "41h 3m" } },
    });
    expect(scheduledContinueRow(5 * 60_000)?.text).toBe("A Continue scheduled 5m ago went out by itself.");
    expect(scheduledContinueRow(75 * 3_600_000)?.text).toBe("A Continue scheduled 3d 3h ago went out by itself.");
});

test("a Continue sent the moment it was pressed leaves no such row", () => {
    expect(scheduledContinueRow(0)).toBeUndefined();
    expect(scheduledContinueRow(59_999)).toBeUndefined();
});
