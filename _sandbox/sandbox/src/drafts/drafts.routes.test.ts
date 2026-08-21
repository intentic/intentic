import type { DraftSummary } from "@intentic/sandbox-contract";
import { APPROVAL_HOLD_MS } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { withApprovalHold } from "./drafts.routes.js";

// What approval writes. The hold IS the countdown: the publisher sleeps on this number and the queue draws
// it, so the cases that must NOT get one matter as much as the case that must.

const NOW = 1_700_000_000_000;

const draft = (overrides: Partial<DraftSummary>): DraftSummary => ({
    id: "d",
    platform: "reddit",
    content: "hello",
    status: "proposed",
    ...overrides,
});

test("approving an undated draft holds it for the countdown rather than sending it", () => {
    expect(withApprovalHold(draft({ status: "approved" }), NOW).scheduledAt).toBe(NOW + APPROVAL_HOLD_MS);
});

test("a date somebody chose is left alone", () => {
    // Next Tuesday already holds itself; a minute added to it would be the daemon overruling the owner.
    expect(withApprovalHold(draft({ status: "approved", scheduledAt: NOW + 86_400_000 }), NOW).scheduledAt).toBe(NOW + 86_400_000);
    // And a post that is already late is late: padding it is a bug wearing caution's coat.
    expect(withApprovalHold(draft({ status: "approved", scheduledAt: NOW - 60_000 }), NOW).scheduledAt).toBe(NOW - 60_000);
});

test("nothing that isn't an approval is touched", () => {
    // A proposal being edited, a failed post sitting there, a record of one already sent: none is about to go
    // out, and a date on any of them would put it in front of the publisher.
    expect(withApprovalHold(draft({}), NOW).scheduledAt).toBeUndefined();
    expect(withApprovalHold(draft({ status: "failed" }), NOW).scheduledAt).toBeUndefined();
    expect(withApprovalHold(draft({ status: "posted", postedAt: NOW }), NOW).scheduledAt).toBeUndefined();
});

test("editing a post that is already counting down does not restart the count", () => {
    // The hold is a deadline, not a debounce on typing: a queue being tidied has to still reach its own.
    const held = withApprovalHold(draft({ status: "approved" }), NOW);
    expect(withApprovalHold({ ...held, content: "edited" }, NOW + 30_000).scheduledAt).toBe(NOW + APPROVAL_HOLD_MS);
});
