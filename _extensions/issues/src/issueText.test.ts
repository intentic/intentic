import type { IssueSummary } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { primaryAction, returned, shortId, statusBadge, timesWords, whereWords } from "./issueText";

const issue = (over: Partial<IssueSummary> = {}): IssueSummary => ({
    id: "4f3a1b2c9d8e7f60",
    kind: "crash",
    title: "TypeError: x is not a function",
    automationId: "bugs",
    firstSeen: 1_000,
    lastSeen: 2_000,
    count: 1,
    status: "open",
    sample: { kind: "crash", message: "TypeError: x is not a function" },
    ...over,
});

/* `open` is the resting state and the majority of this list. A badge on every row is a badge nobody reads, so
 * only the rows that are NOT simply waiting earn one. */
test("only a row that is more than 'waiting' gets a badge", () => {
    expect(statusBadge("open")).toBeUndefined();
    expect(statusBadge("investigating")).toEqual({ label: "being looked at", tone: "primary" });
    expect(statusBadge("resolved")).toEqual({ label: "resolved", tone: "success" });
    expect(statusBadge("ignored")).toEqual({ label: "ignored", tone: "neutral" });
});

/* THE ONE THING THIS INBOX KNOWS THAT NO SINGLE REPORT CAN SAY. The daemon reopens a resolved group when it
 * happens again, so an open row that has already had a turn is a fix that did not hold. */
test("a fix that did not hold is told apart from a bug nobody has looked at", () => {
    expect(returned(issue())).toBe(false);
    expect(returned(issue({ runs: [{ conversationId: "c1", at: 5, atCount: 3 }] }))).toBe(true);
    // Still being worked on is not the same as back: it never left.
    expect(returned(issue({ status: "investigating", runs: [{ conversationId: "c1", at: 5, atCount: 3 }] }))).toBe(false);
});

// A column of counts is scanned rather than read, and the separator is what makes 900 and 9000 tell apart at a
// glance — which is the whole reason the number is on the row.
test("counts read the way somebody would say them", () => {
    expect(timesWords(1)).toBe("once");
    expect(timesWords(2)).toBe("2×");
    expect(timesWords(9204)).toBe(`${(9204).toLocaleString()}×`);
});

// Anything absent is left out rather than rendered as a placeholder: a row of em dashes reads as missing data,
// and every one of these fields is genuinely optional.
test("the sub-line names where it broke, and omits what it does not know", () => {
    expect(whereWords(issue({ culprit: "MyCart@/src/Cart.tsx", release: "a1b2c3d", origin: "https://shop.example" }))).toBe(
        "MyCart@/src/Cart.tsx · build a1b2c3d · https://shop.example",
    );
    expect(whereWords(issue({ origin: "https://shop.example" }))).toBe("https://shop.example");
    expect(whereWords(issue())).toBe("");
});

/* Offering to start a second turn on a bug an agent is already mid-way through fixing is how two worktrees end
 * up editing one file, so a row that is being looked at offers its run instead. */
test("a row being worked on offers its run rather than another turn", () => {
    expect(primaryAction(issue())).toEqual({ kind: "investigate" });
    expect(
        primaryAction(
            issue({
                status: "investigating",
                runs: [
                    { conversationId: "old", at: 1, atCount: 1 },
                    { conversationId: "latest", at: 2, atCount: 4 },
                ],
            }),
        ),
    ).toEqual({ kind: "open", conversationId: "latest" });
    // Investigating with no run recorded (the turn is still being queued) falls back to offering one.
    expect(primaryAction(issue({ status: "investigating" }))).toEqual({ kind: "investigate" });
});

test("the short reference is short enough to read out and long enough to find", () => {
    expect(shortId("4f3a1b2c9d8e7f60")).toBe("4f3a1b2c");
});
