import { EventEmitter } from "node:events";
import type { AgentOptions, InteractionUpdate, SDKCustomTool, SendOptions } from "@cursor/sdk";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Logger } from "pino";
import { waitFor, advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { AgentRequest, CursorCredential } from "../../agent/providers/agent-request.js";
import { nsenterArgv } from "../../workload/namespace-entry.js";
import { createCursorAgent, type CursorAgentDeps, FIRST_DELTA_MS } from "./cursor-agent.js";
import type { CallResult, HostCall, HostMessage, RuntimeMessage } from "./cursor-runtime-protocol.js";
import type { CursorHookService } from "./cursor-hooks.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../testing.js";

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

const create = jest.fn<(options: unknown) => Promise<unknown>>();
const resume = jest.fn<(agentId: string, options: unknown) => Promise<unknown>>();
const cancel = jest.fn<() => Promise<void>>();
// The SDK's catch-all for any error it cannot classify, which a test throws as the SDK would.
class UnknownAgentError extends Error {}

// The mocked SDK's error classes, reached by the anchored turns below to throw one "in the runtime".
class AgentNotFoundError extends Error {}

jest.mock("./cursor-sdk.js", () => ({
    CURSOR_SDK_MISSING: `missing sdk`,
    cursorSdkEntry: async () => SDK_ENTRY,
    cursorSdk: async () => ({
        Agent: { create, resume },
        RateLimitError: class RateLimitError extends Error {},
        AuthenticationError: class AuthenticationError extends Error {},
        AgentBusyError: class AgentBusyError extends Error {},
        AgentNotFoundError,
        UnknownAgentError,
        NetworkError: class NetworkError extends Error {},
    }),
}));

const MODEL = `claude-opus-5`;
const SDK_ENTRY = `/opt/cursor-sdk/node_modules/@cursor/sdk/dist/esm/index.js`;

const deps = (): CursorAgentDeps => ({
    catalog: {
        models: async () => ({ models: [{ id: MODEL, label: MODEL }], default: MODEL }),
        item: async () => undefined,
    },
    hooks: unstubbed<CursorHookService>(`hooks`, { register: () => () => {} }),
    logger: unstubbed<Logger>(`logger`, { warn: () => {} }),
});

const request = (): AgentRequest<CursorCredential> => ({
    spec: { prompt: `add an auto mode of model selecting`, cwd: WORKSPACE_ROOT, model: MODEL },
    policy: {},
    tools: {},
    credential: { kind: `cursor-key`, apiKey: `key` },
    hooks: { cards },
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

    expect(cards.resolve({ kind: `question`, requestId: card?.requestId ?? ``, answers: { [QUESTION.question]: [`Postgres`] } })).toBe(`settled`);
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
        for await (const event of createCursorAgent(deps())({ ...request(), policy: { permissionMode: `plan` } })) {
            seen.push(event);
        }
    })();

    await waitFor(() => expect(settle).toHaveLength(1));
    settle[0]?.({ status: `success` });
    await waitFor(() => expect(seen.map((event) => event.kind)).toContain(`plan`));
    const plan = seen.find((event): event is Extract<AgentEvent, { kind: `plan` }> => event.kind === `plan`);
    // Planning holds the prose back rather than streaming it: the plan is what the phase captured.
    expect(plan?.text).toBe(`ship it`);

    expect(cards.resolve({ kind: `plan`, requestId: plan?.requestId ?? ``, approve: true })).toBe(`settled`);
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

// The live failure these cover: an OOM kill took the daemon down mid-run, and the SDK's store kept that run RUNNING on
// disk. Every later send on the agent threw "already has active run", and the frame was coded session-not-found, so the
// editor dropped the session without a word while the daemon kept resuming the same wedged agent.
test("a resumed agent's first send expires the run a killed daemon left open, and later phases are sent plainly", async () => {
    const sent: SendOptions[] = [];
    resume.mockResolvedValue({
        agentId: `agent-resumed`,
        send: async (_prompt: string, options: SendOptions) => {
            sent.push(options);
            options.onDelta?.({ update: { type: `text-delta`, text: sent.length === 1 ? `ship it` : `working on it` } as InteractionUpdate });
            return { wait: async () => ({ status: `success` }), cancel };
        },
        close: () => {},
    });

    const seen: AgentEvent[] = [];
    const resumed = { ...request(), spec: { ...request().spec, sessionId: `agent-resumed` }, policy: { permissionMode: `plan` as const } };
    const turn = (async () => {
        for await (const event of createCursorAgent(deps())(resumed)) {
            seen.push(event);
        }
    })();
    await waitFor(() => expect(seen.map((event) => event.kind)).toContain(`plan`));
    const plan = seen.find((event): event is Extract<AgentEvent, { kind: `plan` }> => event.kind === `plan`);
    expect(cards.resolve({ kind: `plan`, requestId: plan?.requestId ?? ``, approve: true })).toBe(`settled`);
    await turn;

    expect(resume.mock.calls.map(([agentId]) => agentId)).toEqual([`agent-resumed`]);
    expect(sent.map((options) => options.local)).toEqual([{ force: true }, undefined]);
});

test("a fresh agent has no run to orphan, so its send does not force", async () => {
    const sent: SendOptions[] = [];
    agentThat(
        (options) => sent.push(options),
        async () => ({ status: `success` }),
    );
    await collect(createCursorAgent(deps())(request()));
    expect(sent.map((options) => options.local)).toEqual([undefined]);
});

test("the SDK's catch-all error is reported as the failure it is, not as a lost session", async () => {
    const wedged = `Agent agent-stalled already has active run`;
    create.mockResolvedValue({
        agentId: `agent-stalled`,
        send: async () => {
            throw new UnknownAgentError(wedged);
        },
        close: () => {},
    });
    const events = await collect(createCursorAgent(deps())(request()));
    expect(events.filter((event) => event.kind === `error`)).toEqual([{ kind: `error`, message: wedged }]);
    expect(events.at(-1)).toEqual({ kind: `done` });
});

// An isolated turn's placement: its worktree, and the namespace anchor that makes it /work, when the container has one.
const plan = { worktree: `${HISTORY_ROOT}/worktrees/c1/work`, root: WORKSPACE_ROOT, mirrors: [], overlays: `${HISTORY_ROOT}/overlays/c1`, fence: undefined };
const anchored = (base = request()): AgentRequest<CursorCredential> => ({
    ...base,
    spec: { ...base.spec, spawnDepth: 1, isolation: { plan, anchor: { pid: 4321, cwd: WORKSPACE_ROOT, plan, dispose: () => {} } } },
});

// An SDK error as the runtime reports one: its message, and the class the daemon rebuilds it as.
class RuntimeRefusal extends Error {
    constructor(
        message: string,
        readonly coded: `AgentNotFoundError`,
    ) {
        super(message);
    }
}

type RuntimeAnswer = (call: HostCall, emit: (message: RuntimeMessage) => void) => CallResult | Promise<CallResult>;

// The runtime process as the daemon sees it: every call it is sent is recorded, and answered by `answer`, which can push
// its own messages first, as the real one streams deltas and relays tool calls before it replies. `replied` settles on
// the first message that is not a call: the answer to a tool the runtime relayed.
const fakeRuntime = (answer: RuntimeAnswer) => {
    const calls: HostCall[] = [];
    const replies: HostMessage[] = [];
    const spawned: { command: string; args: readonly string[]; spawnDepth: number }[] = [];
    let settleReplied: () => void = () => {};
    const replied = new Promise<void>((resolve) => {
        settleReplied = resolve;
    });
    const child = Object.assign(new EventEmitter(), {
        stdout: null,
        stderr: null,
        connected: true,
        exitCode: null,
        signalCode: null,
        disconnect: () => {},
        kill: () => true,
        send: (message: HostMessage, done: (error: Error | null) => void) => {
            done(null);
            if (message.kind !== `call`) {
                replies.push(message);
                settleReplied();
                return true;
            }
            calls.push(message.call);
            const emit = (reply: RuntimeMessage): void => void child.emit(`message`, reply);
            void Promise.resolve()
                .then(() => answer(message.call, emit))
                .then(
                    (value) => emit({ kind: `reply`, seq: message.seq, ok: true, value }),
                    (error: RuntimeRefusal) => emit({ kind: `reply`, seq: message.seq, ok: false, error: { message: error.message, coded: error.coded } }),
                );
            return true;
        },
    });
    const runtime: NonNullable<CursorAgentDeps[`runtime`]> = {
        command: { file: `/usr/local/bin/node`, args: [`/opt/sandbox/dist/runtimes/cursor/cursor-agent-runtime.js`] },
        spawn: (command, args, spawnDepth) => {
            spawned.push({ command, args, spawnDepth });
            return child;
        },
    };
    return { calls, replies, replied, spawned, runtime, child };
};

// What a runtime answers for one ordinary turn: the agent opened, one delta, the run finished.
const oneTurn: RuntimeAnswer = (call, emit) => {
    switch (call.method) {
        case `open`:
            return { agentId: `agent-ns` };
        case `send`:
            emit({ kind: `delta`, run: call.run, update: { type: `text-delta`, text: `from the worktree` } });
            return { steerable: false };
        case `wait`:
            return { status: `finished` };
        default:
            return null;
    }
};

test("an anchored turn's SDK agent is born in the turn's mount namespace, at /work as the namespace sees it", async () => {
    const fake = fakeRuntime(oneTurn);

    const events = await collect(createCursorAgent({ ...deps(), runtime: fake.runtime })(anchored()));

    // nsenter into the anchor's namespace by pid, cwd resolved there, so /work is the worktree before the SDK loads.
    expect(fake.spawned).toEqual([
        {
            ...nsenterArgv(4321, WORKSPACE_ROOT, `/usr/local/bin/node`, [`/opt/sandbox/dist/runtimes/cursor/cursor-agent-runtime.js`, SDK_ENTRY]),
            spawnDepth: 1,
        },
    ]);
    expect(fake.spawned[0]?.args.slice(0, 2)).toEqual([`--mount=/proc/4321/ns/mnt`, `--wdns=${WORKSPACE_ROOT}`]);
    // Nothing of the SDK ran in the daemon: the agent was opened in the runtime, scoped to the namespace's /work.
    expect(create).not.toHaveBeenCalled();
    const open = fake.calls.find((call): call is Extract<HostCall, { method: `open` }> => call.method === `open`);
    expect(open?.options.local?.cwd).toBe(WORKSPACE_ROOT);
    expect(open?.options.apiKey).toBe(`key`);
    expect(fake.calls.map((call) => call.method)).toEqual([`open`, `send`, `wait`, `close`]);
    expect(events).toContainEqual({ kind: `session`, sessionId: `agent-ns` });
    expect(events).toContainEqual({ kind: `delta`, text: `from the worktree` });
    expect(events.some((event) => event.kind === `error`)).toBe(false);
    expect(events.at(-1)).toEqual({ kind: `done` });
});

test("an isolated turn the container could not anchor runs its agent in this process, cwd'd into its worktree", async () => {
    const fake = fakeRuntime(oneTurn);
    agentThat(
        () => {},
        async () => ({ status: `success` }),
    );
    const cwdOnly = { ...request(), spec: { ...request().spec, cwd: plan.worktree, isolation: { plan } } };

    await collect(createCursorAgent({ ...deps(), runtime: fake.runtime })(cwdOnly));

    expect(fake.spawned).toEqual([]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ local: expect.objectContaining({ cwd: plan.worktree }) }));
});

test("a custom tool the SDK calls in the runtime runs in the daemon, and its answer goes back to the runtime", async () => {
    const fake = fakeRuntime((call, emit) => {
        if (call.method === `send`) {
            emit({ kind: `tool`, call: 0, name: `ask`, args: { questions: [QUESTION] }, toolCallId: `t1` });
            return { steerable: false };
        }
        // The run holds until the tool has been answered, as Cursor's loop does.
        return call.method === `wait` ? fake.replied.then(() => ({ status: `finished` })) : oneTurn(call, emit);
    });

    const seen: AgentEvent[] = [];
    const turn = (async () => {
        for await (const event of createCursorAgent({ ...deps(), runtime: fake.runtime })(anchored())) {
            seen.push(event);
        }
    })();
    await waitFor(() => expect(seen.map((event) => event.kind)).toContain(`question`));
    const card = seen.find((event): event is Extract<AgentEvent, { kind: `question` }> => event.kind === `question`);
    expect(cards.resolve({ kind: `question`, requestId: card?.requestId ?? ``, answers: { [QUESTION.question]: [`SQLite`] } })).toBe(`settled`);
    await turn;

    // The open call named the tool without its handler, which stayed here.
    const open = fake.calls.find((call): call is Extract<HostCall, { method: `open` }> => call.method === `open`);
    expect(open?.tools.map((tool) => tool.name)).toContain(`ask`);
    expect(open?.tools.every((tool) => !(`execute` in tool))).toBe(true);
    expect(fake.replies).toEqual([{ kind: `tool-reply`, call: 0, ok: true, value: `The user answered:\n- Store: SQLite` }]);
    expect(seen.at(-1)).toEqual({ kind: `done` });
});

test("an SDK error thrown in the runtime is coded as the same error thrown in this process", async () => {
    const fake = fakeRuntime((call) => {
        if (call.method === `open`) {
            throw new RuntimeRefusal(`no agent here`, `AgentNotFoundError`);
        }
        return null;
    });
    const resumed = anchored({ ...request(), spec: { ...request().spec, sessionId: `agent-gone` } });

    const events = await collect(createCursorAgent({ ...deps(), runtime: fake.runtime })(resumed));

    expect(fake.calls[0]).toMatchObject({ method: `open`, resume: `agent-gone` });
    expect(events).toEqual([{ kind: `error`, message: `no agent here`, code: `session-not-found` }, { kind: `done` }]);
});

test("a runtime that dies mid-turn ends the turn with its exit, rather than leaving it running", async () => {
    const fake = fakeRuntime((call, emit) => (call.method === `wait` ? new Promise(() => {}) : oneTurn(call, emit)));
    const seen: AgentEvent[] = [];
    const turn = (async () => {
        for await (const event of createCursorAgent({ ...deps(), runtime: fake.runtime })(anchored())) {
            seen.push(event);
        }
    })();
    await waitFor(() => expect(fake.calls.map((call) => call.method)).toContain(`wait`));

    fake.child.emit(`exit`, 137, null);
    await turn;

    expect(seen.find((event) => event.kind === `error`)).toMatchObject({ message: expect.stringContaining(`The Cursor runtime process exited (137)`) });
    expect(seen.at(-1)).toEqual({ kind: `done` });
});
