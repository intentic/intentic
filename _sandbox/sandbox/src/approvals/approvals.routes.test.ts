import type { PostApprovalSummary } from "@intentic/sandbox-contract";
import { APPROVAL_HOLD_MS } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { withApprovalHold } from "./approvals.routes.js";

/* The hold is the one thing approval WRITES, so it is the one thing worth pinning: an approved item with no
 * date gets exactly one hold from now, and nothing else about the record is touched. */

const NOW = 1_700_000_000_000;
const post = (overrides: Partial<PostApprovalSummary>): PostApprovalSummary => ({
    id: "p",
    kind: "post",
    platform: "x",
    content: "hello",
    status: "proposed",
    ...overrides,
});

test("an approved item with no date is dated one hold ahead", () => {
    expect(withApprovalHold(post({ status: "approved" }), NOW).scheduledAt).toBe(NOW + APPROVAL_HOLD_MS);
});

test("a date the owner or the agent chose is left alone, in either direction", () => {
    // Next Tuesday is held by its own date; a post an hour late is not made a minute later still.
    expect(withApprovalHold(post({ status: "approved", scheduledAt: NOW + 86_400_000 }), NOW).scheduledAt).toBe(NOW + 86_400_000);
    expect(withApprovalHold(post({ status: "approved", scheduledAt: NOW - 3_600_000 }), NOW).scheduledAt).toBe(NOW - 3_600_000);
});

test("only approval starts a hold: a proposal, an edit, or putting one back stays undated", () => {
    expect(withApprovalHold(post({ status: "proposed" }), NOW).scheduledAt).toBeUndefined();
    expect(withApprovalHold(post({ status: "failed" }), NOW).scheduledAt).toBeUndefined();
});

test("re-approving a held item after an edit restarts the hold from the edit, not from the first approval", () => {
    // "Put it back in review" clears the date; the second approval is a fresh decision and gets a fresh minute.
    const held = withApprovalHold(post({ status: "approved" }), NOW);
    const back = { ...held, status: "proposed" as const, scheduledAt: undefined };
    expect(withApprovalHold({ ...back, status: "approved", content: "edited" }, NOW + 30_000).scheduledAt).toBe(NOW + 30_000 + APPROVAL_HOLD_MS);
});
