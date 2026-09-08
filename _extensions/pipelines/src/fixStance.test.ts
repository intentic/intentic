import type { AgentSummary } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { fixStance } from "./fixStance";

const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };

const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
    id: `ci-fix-web-42`,
    status: `running`,
    provider: `claude`,
    harness: `native`,
    attention: { ...NO_ATTENTION },
    updatedAt: 1_000,
    ...over,
});

test("a live turn reads as work in progress, and asks nothing of the reader", () => {
    const stance = fixStance(agent({ status: `running` }));
    expect(stance.kind).toBe(`working`);
    expect(stance.spin).toBe(true);
    expect(stance.ongoing).toBe(true);
    expect(stance.retry).toBe(false);
});

test.each([`resuming`, `stopping`, `dismissing`] as const)("%s still reads as working", (status) => {
    expect(fixStance(agent({ status })).kind).toBe(`working`);
});

test("a parked turn is read off the attention flag, not the status", () => {
    const stance = fixStance(agent({ status: `idle`, attention: { ...NO_ATTENTION, question: true } }));
    expect(stance.kind).toBe(`needs-you`);
    expect(stance.label).toBe(`Question for you`);
    expect(stance.ongoing).toBe(true);
});

test("a setup that is not connected yet outranks a question raised beside it", () => {
    const stance = fixStance(agent({ status: `awaiting`, attention: { ...NO_ATTENTION, question: true, capability: true } }));
    expect(stance.label).toBe(`Setup needed`);
});

test("a turn parked with no flag yet still says it is waiting on you", () => {
    expect(fixStance(agent({ status: `awaiting` })).kind).toBe(`needs-you`);
});

test("held work reads as a fix to review, whether the fleet called it ready or left it idle", () => {
    expect(fixStance(agent({ status: `ready` })).kind).toBe(`ready`);
    expect(fixStance(agent({ status: `idle`, diff: { files: 4, insertions: 120, deletions: 8 } })).kind).toBe(`ready`);
});

// Diff present doesn't change a failed status to ready; it only earns a mention in the hint.
test("an agent that failed after writing files still reads as failed", () => {
    const stance = fixStance(agent({ status: `error`, diff: { files: 2, insertions: 34, deletions: 6 } }));
    expect(stance.kind).toBe(`ended`);
    expect(stance.retry).toBe(true);
    expect(stance.hint).toContain(`2 changed files on its branch`);
});

test("a finished turn that changed nothing offers to try again", () => {
    const stance = fixStance(agent({ status: `idle` }));
    expect(stance.kind).toBe(`ended`);
    expect(stance.label).toBe(`Nothing changed`);
    expect(stance.retry).toBe(true);
    expect(stance.ongoing).toBe(false);
});

test("a landed fix is over, and stops holding the branch's other rows back", () => {
    const stance = fixStance(agent({ status: `landed`, diff: { files: 2, insertions: 10, deletions: 1 } }));
    expect(stance.kind).toBe(`landed`);
    expect(stance.ongoing).toBe(false);
    expect(stance.retry).toBe(false);
});

test("a failed turn carries the provider's own sentence into the hint", () => {
    const stance = fixStance(agent({ status: `error`, failure: `the model endpoint refused the request` }));
    expect(stance.kind).toBe(`ended`);
    expect(stance.retry).toBe(true);
    expect(stance.hint).toContain(`the model endpoint refused the request`);
});

// Retry is false because retrying would spend the same already-refused allowance.
test("a spent allowance reads as a wait rather than an error", () => {
    const stance = fixStance(agent({ status: `error`, failureCode: `rate_limit`, failure: `usage limit reached` }));
    expect(stance.kind).toBe(`waiting`);
    expect(stance.retry).toBe(false);
    expect(stance.ongoing).toBe(true);
});

test("a stopped turn says so, and offers the press again", () => {
    const stance = fixStance(agent({ status: `stopped` }));
    expect(stance.label).toBe(`Stopped`);
    expect(stance.retry).toBe(true);
});

// An unknown status can arrive from a newer daemon; the stance must still draw rather than crash on `undefined.icon`.
test("an unknown ending still produces a drawable stance", () => {
    const stance = fixStance(agent({ status: `teleported` as AgentSummary["status"] }));
    expect(stance.kind).toBe(`ended`);
    expect(stance.label).toBe(`Agent stopped`);
    expect(stance.icon).toBe(`exclamation-triangle`);
});
