import type { S2sContactTask } from "@intentic/sandbox-contract/schemas/s2s";
import { unstubbed } from "@intentic/testing";
import { inSetup, provided } from "../../testing/inSetup";
import { MESSAGES_API, type MessagesApi } from "./messagesApi";
import { taskKey, useTaskDecision } from "./useTaskDecision";

// Allow and Decline on a contact's task that waits for the owner: each names the task by its contact and the asking
// side's own id, says which answer it is, takes one answer at a time, and says a refusal in the daemon's own words.

const WAITING: S2sContactTask = {
    contact: `research`,
    contactName: `research-desk`,
    requestId: `rq-churn`,
    conversationId: `link-churn`,
    title: `Churn by cohort`,
    state: `held`,
    askedAt: 1,
    updatedAt: 1,
};

type Call = readonly [contact: string, request: string, approve: boolean];

const decisionWith = (answer: (call: Call) => Promise<S2sContactTask>) => {
    const calls: Call[] = [];
    const api = unstubbed<MessagesApi>(`messages`, {
        decideTask: async (contact, request, approve) => {
            const call = [contact, request, approve] as const;
            calls.push(call);
            return answer(call);
        },
    });
    const { result } = inSetup(() => useTaskDecision(), { provides: [provided(MESSAGES_API, api)] });
    return { decision: result, calls };
};

const answered = async ([, , approve]: Call): Promise<S2sContactTask> => ({ ...WAITING, state: approve ? `running` : `declined` });

it(`allows a waiting task by its contact and request id`, async () => {
    const { decision, calls } = decisionWith(answered);
    expect(await decision.decide(WAITING, true)).toBe(true);
    expect(calls).toEqual([[`research`, `rq-churn`, true]]);
    expect([decision.deciding.value, decision.notice.value]).toEqual([undefined, undefined]);
});

it(`declines a waiting task, saying so to the daemon rather than allowing it`, async () => {
    const { decision, calls } = decisionWith(answered);
    expect(await decision.decide(WAITING, false)).toBe(true);
    expect(calls).toEqual([[`research`, `rq-churn`, false]]);
});

it(`marks the task being answered, and takes no second answer until the daemon has said`, async () => {
    let settle: (task: S2sContactTask) => void = () => undefined;
    const { decision, calls } = decisionWith(() => new Promise((resolve) => (settle = resolve)));
    const first = decision.decide(WAITING, true);
    expect(decision.deciding.value).toBe(`research/rq-churn`);
    expect(await decision.decide({ ...WAITING, requestId: `rq-other` }, false)).toBe(false);
    settle({ ...WAITING, state: `running` });
    expect(await first).toBe(true);
    expect(calls).toEqual([[`research`, `rq-churn`, true]]);
    expect(decision.deciding.value).toBeUndefined();
});

it(`says a refusal in the daemon's words under what the press was`, async () => {
    const { decision } = decisionWith(async () => {
        throw new Error(`That task is not waiting for an answer any more.`);
    });
    expect(await decision.decide(WAITING, true)).toBe(false);
    expect(decision.notice.value).toMatchObject({ tone: `danger`, title: `Couldn't allow the task`, detail: `That task is not waiting for an answer any more.` });
    expect(decision.deciding.value).toBeUndefined();
    expect(await decision.decide(WAITING, false)).toBe(false);
    expect(decision.notice.value).toMatchObject({ title: `Couldn't decline the task` });
});

it(`keys a task by its contact and request id, so two contacts' equal ids stay apart`, () => {
    expect(taskKey(WAITING)).toBe(`research/rq-churn`);
    expect(taskKey({ contact: `billing`, requestId: `rq-churn` })).toBe(`billing/rq-churn`);
});
