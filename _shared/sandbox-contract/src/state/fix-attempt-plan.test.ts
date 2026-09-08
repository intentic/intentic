import { expect, test } from "vitest";
import { ciFixConversationId, fixAttemptId } from "../ids/conversation-ids.js";
import type { AgentSummary } from "../schemas/agents.js";
import { planFixAttempt } from "./fix-attempt-plan.js";

const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const BASE = ciFixConversationId(`web`, 41);

const agent = (id: string, over: Partial<AgentSummary> = {}): AgentSummary => ({
    id,
    status: `running`,
    provider: `claude`,
    harness: `native`,
    attention: { ...NO_ATTENTION },
    updatedAt: 1_000,
    ...over,
});

test("with nobody on the failure, a press opens attempt 1 under the failure's own id", () => {
    expect(planFixAttempt(BASE, [], [])).toEqual({ kind: `new`, conversationId: BASE, attempt: 1 });
});

// The archive counts: attempt 1 was set aside earlier, and re-minting its id would un-archive it.
test("an archived attempt is skipped over, not resurrected", () => {
    expect(planFixAttempt(BASE, [], [BASE])).toEqual({ kind: `new`, conversationId: fixAttemptId(BASE, 2), attempt: 2 });
});

test("a landed attempt is closed: the same gates red again get a fresh attempt", () => {
    const plan = planFixAttempt(BASE, [agent(BASE, { status: `landed` })], []);
    expect(plan).toEqual({ kind: `new`, conversationId: fixAttemptId(BASE, 2), attempt: 2 });
});

test("an attempt that ended is continued by a plain press, and by an explicit Continue", () => {
    const roster = [agent(BASE, { status: `error`, failure: `no capacity` })];
    expect(planFixAttempt(BASE, roster, [])).toEqual({ kind: `continue`, conversationId: BASE, attempt: 1 });
    expect(planFixAttempt(BASE, roster, [], `continue`)).toEqual({ kind: `continue`, conversationId: BASE, attempt: 1 });
});

test("start over retires the latest attempt and numbers the next past it", () => {
    const second = fixAttemptId(BASE, 2);
    const plan = planFixAttempt(BASE, [agent(BASE, { status: `stopped` }), agent(second, { status: `error` })], [], `start-over`);
    expect(plan).toEqual({ kind: `start-over`, retire: second, stopFirst: false, conversationId: fixAttemptId(BASE, 3), attempt: 3 });
});

// Only a running turn needs stopping before the archive will take it; a parked one is already still.
test("starting over on a working attempt stops it first", () => {
    const plan = planFixAttempt(BASE, [agent(BASE, { status: `running` })], [], `start-over`);
    expect(plan).toMatchObject({ kind: `start-over`, retire: BASE, stopFirst: true });
    const parked = planFixAttempt(BASE, [agent(BASE, { status: `awaiting`, attention: { ...NO_ATTENTION, question: true } })], [], `start-over`);
    expect(parked).toMatchObject({ kind: `start-over`, stopFirst: false });
});

// A second agent beside a live one is the race the derived id exists to prevent; the press opens the live one instead.
test.each([`running`, `awaiting`, `ready`] as const)("an attempt still in play (%s) is busy, not a fresh press", (status) => {
    const plan = planFixAttempt(BASE, [agent(BASE, { status })], []);
    expect(plan).toMatchObject({ kind: `busy`, conversationId: BASE });
    // Continue is not a way around it either.
    expect(planFixAttempt(BASE, [agent(BASE, { status })], [], `continue`).kind).toBe(`busy`);
});

test("a spent allowance is a wait, not an ending: the press does not spend it again", () => {
    const plan = planFixAttempt(BASE, [agent(BASE, { status: `error`, failureCode: `rate_limit` })], []);
    expect(plan.kind).toBe(`busy`);
});
