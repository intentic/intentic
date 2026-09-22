import type { AgentOptions, InteractionUpdate, SDKCustomTool, SendOptions } from "@cursor/sdk";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Logger } from "pino";
import { test, expect, beforeEach, mock, jest } from "bun:test";
import { waitFor, advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { AgentRequest } from "../../agent/run/agent.js";
import { resolveRequest } from "../../agent/tools/agent-requests.js";
import { createCursorAgent, type CursorAgentDeps, FIRST_DELTA_MS } from "./cursor-agent.js";
import type { CursorHookService } from "./cursor-hooks.js";

const create = mock<(options: unknown) => Promise<unknown>>();
const cancel = mock<() => Promise<void>>();

mock.module("./cursor-sdk.js", () => ({
    CURSOR_SDK_MISSING: `missing sdk`,
    cursorSdk: async () => ({
        Agent: { create },
        RateLimitError: class RateLimitError extends Error {},
        AuthenticationError: class AuthenticationError extends Error {},
        AgentBusyError: class AgentBusyError extends Error {},
        AgentNotFoundError: class AgentNotFoundError extends Error {},
        UnknownAgentError: class UnknownAgentError extends Error {},
        NetworkError: class NetworkError extends Error {},
    }),
}));

const MODEL = `claude-opus-5`;

const deps = (): CursorAgentDeps => ({
    catalog: {
        models: async () => ({ models: [{ id: MODEL, label: MODEL }], default: MODEL }),
        item: async () => undefined,
    },
    hooks: unstubbed<CursorHookService>(`hooks`, { register: () => () => {} }),
    logger: unstubbed<Logger>(`logger`, { warn: () => {} }),
});

const request = (): AgentRequest => ({
    prompt: `add an auto mode of model selecting`,
    cwd: WORKSPACE_ROOT,
    model: MODEL,
    cursorApiKey: `key`,
    signal: new AbortController().signal,
});

const collect = async (events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> => {
    const seen: AgentEvent[] = [];
    for await (const event of events) {
        seen.push(event);
    }
    return seen;
};

// A run handle whose `wait` resolves only when the test says so, standing in for a turn still working.
const agentThat = (send: (options: SendOptions) => void, wait: () => Promise<unknown>): void => {
    create.mockResolvedValue({
        agentId: `agent-stalled`,
        send: async (_prompt: string, options: SendOptions) => {
            send(options);
            return { wait, cancel };
        },
        close: () => {},
    });
};

beforeEach(() => {
    jest.clearAllMocks();
    cancel.mockResolvedValue(undefined);
});

// The live failure this bounds: Cursor took the turn, named a session, and then sent neither a delta nor a settle. The
// turn stood "running" for an hour with no frame, no log and no error to resume from.
test("a run that takes the turn and then says nothing at all ends as an outage rather than waiting forever", async () => {
    agentThat(
        () => {},
        () => new Promise(() => {}),
    );
    jest.useFakeTimers();
    try {
        const turn = collect(createCursorAgent(deps())(request()));
        await advanceTimersByTimeAsync(FIRST_DELTA_MS + 1);
        jest.useRealTimers();
        const events = await turn;

        // provider-outage is what routes it to the breaker's queue, which resumes it on the session below.
        expect(events.find((event) => event.kind === `error`)).toMatchObject({ code: `provider-outage` });
        expect(events[0]).toEqual({ kind: `session`, sessionId: `agent-stalled` });
        expect(events.at(-1)).toEqual({ kind: `done` });
        expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
        jest.useRealTimers();
    }
});

const QUESTION = {
    question: `Which store?`,
    header: `Store`,
    multiSelect: false,
    options: [
        { label: `Postgres`, description: `p` },
        { label: `SQLite`, description: `s` },
    ],
};

// The live failure this covers: a card raised inside a custom tool waited for the next delta to be flushed out, and the
// tool parked on that card is precisely what stops the deltas. The question was never shown, so it was never answered,
// and the turn stood there until it was stopped — at which point the card finally appeared, unanswerable.
test("a question raised inside a tool is streamed while that tool is still waiting for its answer", async () => {
    let settleRun: (result: { status: string }) => void = () => {};
    const ran = new Promise<{ status: string }>((resolve) => {
        settleRun = resolve;
    });
    let asked: Promise<unknown> | undefined;
    agentThat(
        () => {
            // Cursor invokes a custom tool inside its own loop and deltas nothing until the handler returns.
            const created = create.mock.lastCall?.[0] as AgentOptions;
            const ask = created.local?.customTools?.[`ask`] as SDKCustomTool;
            asked = Promise.resolve(ask.execute({ questions: [QUESTION] }, {}));
        },
        () => ran,
    );

    const seen: AgentEvent[] = [];
    const turn = (async () => {
        for await (const event of createCursorAgent(deps())(request())) {
            seen.push(event);
        }
    })();

    await waitFor(() => expect(seen.map((event) => event.kind)).toContain(`question`));
    const card = seen.find((event): event is Extract<AgentEvent, { kind: `question` }> => event.kind === `question`);
    expect(card?.questions).toEqual([QUESTION]);

    expect(resolveRequest({ kind: `question`, requestId: card?.requestId ?? ``, answers: { [QUESTION.question]: [`Postgres`] } })).toBe(`settled`);
    expect(await asked).toBe(`The user answered:\n- Store: Postgres`);

    settleRun({ status: `success` });
    await turn;
    // The card's resolution is a pushed frame too, and the transcript replays the answered card from it.
    expect(seen.filter((event) => event.kind === `resolved`)).toEqual([{ kind: `resolved`, requestId: card!.requestId, reply: expect.anything() }]);
    expect(seen.at(-1)).toEqual({ kind: `done` });
});

// Two phases over one queue, since the tools that push into it are bound once, when the agent is created: what ends the
// planning phase's drain must not still be sitting in the queue when the approved phase starts.
test("an approved plan streams its executing phase on the queue the planning phase ended", async () => {
    const settle: ((result: { status: string }) => void)[] = [];
    let phases = 0;
    create.mockResolvedValue({
        agentId: `agent-planning`,
        send: async (_prompt: string, options: SendOptions) => {
            phases += 1;
            options.onDelta?.({ update: { type: `text-delta`, text: phases === 1 ? `ship it` : `working on it` } as InteractionUpdate });
            return { wait: () => new Promise((resolve: (result: { status: string }) => void) => settle.push(resolve)), cancel };
        },
        close: () => {},
    });

    const seen: AgentEvent[] = [];
    const turn = (async () => {
        for await (const event of createCursorAgent(deps())({ ...request(), permissionMode: `plan` })) {
            seen.push(event);
        }
    })();

    await waitFor(() => expect(settle).toHaveLength(1));
    settle[0]?.({ status: `success` });
    await waitFor(() => expect(seen.map((event) => event.kind)).toContain(`plan`));
    const plan = seen.find((event): event is Extract<AgentEvent, { kind: `plan` }> => event.kind === `plan`);
    // Planning holds the prose back rather than streaming it: the plan is what the phase captured.
    expect(plan?.text).toBe(`ship it`);

    expect(resolveRequest({ kind: `plan`, requestId: plan?.requestId ?? ``, approve: true })).toBe(`settled`);
    await waitFor(() => expect(settle).toHaveLength(2));
    settle[1]?.({ status: `success` });
    await turn;

    expect(seen.filter((event) => event.kind === `delta`)).toEqual([{ kind: `delta`, text: `working on it` }]);
    expect(seen.at(-1)).toEqual({ kind: `done` });
});

// The bound is on the opening only: a turn that has streamed is a turn Cursor is answering, and a long quiet stretch
// there is a tool call running, not a stall. Capping it would end working turns.
test("a quiet stretch after the first delta is a tool call running long, and is left alone", async () => {
    let settle: (result: { status: string }) => void = () => {};
    const waited = new Promise<{ status: string }>((resolve) => {
        settle = resolve;
    });
    agentThat(
        (options) => options.onDelta?.({ update: { type: `text-delta`, text: `looking` } as InteractionUpdate }),
        () => waited,
    );
    jest.useFakeTimers();
    try {
        const turn = collect(createCursorAgent(deps())(request()));
        await advanceTimersByTimeAsync(FIRST_DELTA_MS * 3);
        expect(cancel).not.toHaveBeenCalled();

        settle({ status: `success` });
        jest.useRealTimers();
        const events = await turn;
        expect(events.some((event) => event.kind === `error`)).toBe(false);
        expect(events.at(-1)).toEqual({ kind: `done` });
    } finally {
        jest.useRealTimers();
    }
});
