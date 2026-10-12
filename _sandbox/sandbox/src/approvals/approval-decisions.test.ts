import type { ActionApprovalSummary, AutomationApproval, PostApprovalSummary } from "@intentic/sandbox-contract";
import { approvalDigest, fieldsDigest } from "./approval-decisions.js";

// A yes is pinned to a digest of what it covers, and a ledger written by an earlier release is read by this one: the
// digest of an item that has not changed must be the one that release wrote. These are the values the implementation
// before held wakes shared it gave for these two items.

const post: PostApprovalSummary = { id: "p1", kind: "post", platform: "x", content: "Hello", media: [], status: "approved", createdAt: 1 };
const action: ActionApprovalSummary = {
    id: "a1",
    kind: "action",
    summary: "Pay the invoice",
    instructions: "Pay it.",
    status: "approved",
    createdAt: 1,
    scheduledAt: 5,
};

test("an item's digest is the one earlier releases pinned", async () => {
    expect(await approvalDigest("/nonexistent", post)).toBe("e6561cdf00f0bdb2e7afa194a3c7f309a7288a97c05ba8b512b4dccbad507512");
    expect(await approvalDigest("/nonexistent", action)).toBe("6acb9e018e525c60b71c8db6aea2f7621344c4a580efd39a95f9942a3689888c");
});

test("bookkeeping does not change what an item covers, and anything else does", async () => {
    const before = await approvalDigest("/nonexistent", action);
    expect(await approvalDigest("/nonexistent", { ...action, status: "running", startedAt: 9, result: "done" })).toBe(before);
    expect(await approvalDigest("/nonexistent", { ...action, summary: "Pay a different invoice" })).not.toBe(before);
});

// The same digest serves a held wake: every field but its id and the daemon's signature, keys in any order, absent fields
// the same as missing ones.
test("a held wake's digest ignores the order of its keys and the fields left out of it", () => {
    const skip = new Set(["id", "mint"]);
    const wake: AutomationApproval = { id: "w1", automationId: "inbox", payload: "ping", createdAt: 1 };
    const reordered: AutomationApproval = { createdAt: 1, payload: "ping", automationId: "inbox", id: "w2" };
    expect(fieldsDigest(wake, skip)).toBe(fieldsDigest(reordered, skip));
    expect(fieldsDigest({ ...wake, observed: undefined }, skip)).toBe(fieldsDigest(wake, skip));
    expect(fieldsDigest({ ...wake, payload: "pong" }, skip)).not.toBe(fieldsDigest(wake, skip));
});
