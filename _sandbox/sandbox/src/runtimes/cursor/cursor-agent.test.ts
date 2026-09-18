import type { InteractionUpdate, SendOptions } from "@cursor/sdk";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Logger } from "pino";
import { beforeEach, expect, test, vi } from "vitest";
import type { AgentRequest } from "../../agent/run/agent.js";
import { createCursorAgent, type CursorAgentDeps, FIRST_DELTA_MS } from "./cursor-agent.js";
import type { CursorHookService } from "./cursor-hooks.js";

const create = vi.fn<(options: unknown) => Promise<unknown>>();
const cancel = vi.fn<() => Promise<void>>();

vi.mock("./cursor-sdk.js", () => ({
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
    vi.clearAllMocks();
    cancel.mockResolvedValue(undefined);
});

// The live failure this bounds: Cursor took the turn, named a session, and then sent neither a delta nor a settle. The
// turn stood "running" for an hour with no frame, no log and no error to resume from.
test("a run that takes the turn and then says nothing at all ends as an outage rather than waiting forever", async () => {
    agentThat(
        () => {},
        () => new Promise(() => {}),
    );
    vi.useFakeTimers();
    try {
        const turn = collect(createCursorAgent(deps())(request()));
        await vi.advanceTimersByTimeAsync(FIRST_DELTA_MS + 1);
        vi.useRealTimers();
        const events = await turn;

        // provider-outage is what routes it to the breaker's queue, which resumes it on the session below.
        expect(events.find((event) => event.kind === `error`)).toMatchObject({ code: `provider-outage` });
        expect(events[0]).toEqual({ kind: `session`, sessionId: `agent-stalled` });
        expect(events.at(-1)).toEqual({ kind: `done` });
        expect(cancel).toHaveBeenCalledOnce();
    } finally {
        vi.useRealTimers();
    }
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
    vi.useFakeTimers();
    try {
        const turn = collect(createCursorAgent(deps())(request()));
        await vi.advanceTimersByTimeAsync(FIRST_DELTA_MS * 3);
        expect(cancel).not.toHaveBeenCalled();

        settle({ status: `success` });
        vi.useRealTimers();
        const events = await turn;
        expect(events.some((event) => event.kind === `error`)).toBe(false);
        expect(events.at(-1)).toEqual({ kind: `done` });
    } finally {
        vi.useRealTimers();
    }
});
