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

test("only a row that is more than 'waiting' gets a badge", () => {
    expect(statusBadge("open")).toBeUndefined();
    expect(statusBadge("investigating")).toEqual({ label: "being looked at", tone: "primary" });
    expect(statusBadge("resolved")).toEqual({ label: "resolved", tone: "success" });
    expect(statusBadge("ignored")).toEqual({ label: "ignored", tone: "neutral" });
});

test("a fix that did not hold is told apart from a bug nobody has looked at", () => {
    expect(returned(issue())).toBe(false);
    expect(returned(issue({ runs: [{ conversationId: "c1", at: 5, atCount: 3 }] }))).toBe(true);
    expect(returned(issue({ status: "investigating", runs: [{ conversationId: "c1", at: 5, atCount: 3 }] }))).toBe(false);
});

test("counts read the way somebody would say them", () => {
    expect(timesWords(1)).toBe("once");
    expect(timesWords(2)).toBe("2×");
    expect(timesWords(9204)).toBe(`${(9204).toLocaleString()}×`);
});

test("the sub-line names where it broke, and omits what it does not know", () => {
    expect(whereWords(issue({ culprit: "MyCart@/src/Cart.tsx", release: "a1b2c3d", origin: "https://shop.example" }))).toBe(
        "MyCart@/src/Cart.tsx · build a1b2c3d · https://shop.example",
    );
    expect(whereWords(issue({ origin: "https://shop.example" }))).toBe("https://shop.example");
    expect(whereWords(issue())).toBe("");
});

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
    // No run recorded while investigating (still queued) falls back to offering one.
    expect(primaryAction(issue({ status: "investigating" }))).toEqual({ kind: "investigate" });
});

test("the short reference is short enough to read out and long enough to find", () => {
    expect(shortId("4f3a1b2c9d8e7f60")).toBe("4f3a1b2c");
});
