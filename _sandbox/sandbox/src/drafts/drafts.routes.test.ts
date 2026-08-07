import type { DraftSummary } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { becameDue } from "./drafts.routes.js";

// The truth table behind publish-on-approval: exactly the edits that put a draft into approved-and-due may
// fire the publisher. Everything else either already belonged to the publisher or belongs to the sweep.

const NOW = 1_700_000_000_000;

const draft = (overrides: Partial<DraftSummary>): DraftSummary => ({
    id: "d",
    platform: "reddit",
    content: "hello",
    status: "proposed",
    ...overrides,
});

test("the approve click on an undated draft fires", () => {
    expect(becameDue(draft({}), draft({ status: "approved" }), NOW)).toBe(true);
});

test("the approve click on a past-dated draft fires", () => {
    expect(becameDue(draft({ scheduledAt: NOW - 1 }), draft({ status: "approved", scheduledAt: NOW - 1 }), NOW)).toBe(true);
});

test("approving for a future date waits for the sweep", () => {
    expect(becameDue(draft({}), draft({ status: "approved", scheduledAt: NOW + 60_000 }), NOW)).toBe(false);
});

test("rescheduling an approved draft into the past fires — the owner just asked for it to go out", () => {
    const approved = draft({ status: "approved" });
    expect(becameDue({ ...approved, scheduledAt: NOW + 60_000 }, { ...approved, scheduledAt: NOW }, NOW)).toBe(true);
});

test("editing a draft that is already due does not re-fire — the publisher already has it", () => {
    const due = draft({ status: "approved" });
    expect(becameDue(due, { ...due, content: "edited" }, NOW)).toBe(false);
});

test("a retry — failed back to approved — fires again", () => {
    expect(becameDue(draft({ status: "failed" }), draft({ status: "approved" }), NOW)).toBe(true);
});

test("a draft created directly in approved-and-due state fires", () => {
    expect(becameDue(undefined, draft({ status: "approved" }), NOW)).toBe(true);
});

test("ordinary proposals and rejections never fire", () => {
    expect(becameDue(undefined, draft({}), NOW)).toBe(false);
    expect(becameDue(draft({ status: "approved" }), draft({ status: "proposed" }), NOW)).toBe(false);
});
