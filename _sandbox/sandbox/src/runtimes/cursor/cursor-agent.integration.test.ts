import { EventEmitter } from "node:events";
import type { AgentOptions, InteractionUpdate, SDKCustomTool, SendOptions } from "@cursor/sdk";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Logger } from "pino";
import { waitFor, advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { AgentRequest, CursorCredential } from "../../agent/providers/agent-request.js";
import { forgetNamespaceEntry, nsenterArgv, registerMountEntry, type NamespaceEntryReference } from "../../workload/namespace-entry.js";
import { createCursorAgent, type CursorAgentDeps, FIRST_DELTA_MS } from "./cursor-agent.js";
import type { CallResult, HostCall, HostMessage, RuntimeMessage } from "./cursor-runtime-protocol.js";
import type { CursorHookService } from "./cursor-hooks.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { SteeringQueue } from "../../agent/checkpoints/agent-steering.js";
import { memoryFleet } from "../../testing.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pesel } from "../../privacy/detect/tests/ids.testing.js";
import { privacySliceFake } from "../../privacy/privacy-slice.testing.js";
import { tokenOf } from "../../privacy/tokens.js";

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
    // debug: closing a runtime that already exited is refused, and the host logs that refusal at debug.
    logger: unstubbed<Logger>(`logger`, { warn: () => {}, debug: () => {} }),
});

const request = (): AgentRequest<CursorCredential> => ({
    execution: unstubbed("execution", {}),
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

// A helper's request (agent-request.ts `policy.sealed`). The empty ALLOWLIST is the assertion, and `disallowedTools`
// being absent is half of it: an unknown name in a denylist makes Agent.create reject outright.
test("a sealed request asks with no tool, server or setting source, its system prompt in front of its words", async () => {
    const prompts: string[] = [];
    create.mockResolvedValue({
        agentId: `agent-sealed`,
        send: async (prompt: string, options: SendOptions) => {
            prompts.push(prompt);
            // SAFETY: the mapper reads only `type` and `text` off a text delta.
            options.onDelta?.({ update: { type: `text-delta`, text: `fix: tree truncation` } as InteractionUpdate });
            return { wait: async () => ({ status: `success` }), cancel };
        },
        close: () => {},
    });
    const sealed: AgentRequest<CursorCredential> = {
        ...request(),
        spec: { ...request().spec, prompt: `fix: name the change`, systemPromptMode: `custom`, systemPrompt: `Answer with exactly what is asked.` },
        policy: { sealed: true },
    };

    const events = await collect(createCursorAgent(deps())(sealed));

    expect(create).toHaveBeenCalledWith({ model: { id: MODEL }, apiKey: `key`, tools: [], local: { cwd: WORKSPACE_ROOT, settingSources: [] } });
    expect(prompts).toEqual([`Answer with exactly what is asked.\n\nfix: name the change`]);
    expect(events.filter((event) => event.kind === `delta`)).toEqual([{ kind: `delta`, text: `fix: tree truncation` }]);
    expect(events.at(-1)).toEqual({ kind: `done` });
});

// THE PRIVACY SHIELD ON A CURSOR TURN (cursor-shield.ts), over the real shield. The reported case (2026-10-08): the
// composer warned that Cursor would be turned away before a word was written. A turn now runs, read channel by channel.
describe("a turn the privacy shield reads", () => {
    const NUMBER = pesel(1985, 3, 14, 4562);
    const TOKEN = tokenOf("NATIONAL_ID", 1);
    const shielded = async (spec: Partial<AgentRequest<CursorCredential>["spec"]> = {}, tools: AgentRequest<CursorCredential>["tools"] = {}) => {
        const privacy = await privacySliceFake({ policy: { mode: "on" } }).privacyShield.forTurn("cursor", "native", "c-1");
        const base = request();
        // A folder of its own, so the rules the shield reads before the turn are only what a test writes there.
        const cwd = mkdtempSync(join(tmpdir(), `cursor-agent-turn-`));
        return { ...base, spec: { ...base.spec, cwd, ...spec }, tools, hooks: { ...base.hooks, ...(privacy === undefined ? {} : { privacy }) } };
    };
    const registered: unknown[] = [];
    const hooked = (ready: boolean): CursorAgentDeps => ({
        ...deps(),
        hooks: unstubbed<CursorHookService>(`hooks`, {
            ready: () => ready,
            covers: async () => ready,
            register: (turn) => {
                registered.push(turn);
                return () => {};
            },
        }),
    });
    beforeEach(() => {
        registered.length = 0;
    });

    test("sends the message masked, withholds the tools that read past the shield, proxies MCP, and shows the answer restored", async () => {
        const prompts: string[] = [];
        create.mockResolvedValue({
            agentId: `agent-shielded`,
            send: async (prompt: string, options: SendOptions) => {
                prompts.push(prompt);
                // The model repeats the token it was given, cut across two deltas.
                options.onDelta?.({ update: { type: `text-delta`, text: `Found ${TOKEN.slice(0, 7)}` } as InteractionUpdate });
                options.onDelta?.({ update: { type: `text-delta`, text: `${TOKEN.slice(7)}.` } as InteractionUpdate });
                return { wait: async () => ({ status: `success` }), cancel };
            },
            close: () => {},
        });
        const turn = await shielded(
            { prompt: `who has PESEL ${NUMBER}?`, systemAppend: `Be brief.` },
            { remote: [{ name: `crm`, url: `http://127.0.0.1:8787/mcp/crm`, token: `t` }] as never },
        );
        const events = await collect(createCursorAgent(hooked(true))(turn));

        expect(prompts).toEqual([`who has PESEL ${TOKEN}?`]);
        const options = create.mock.calls[0]?.[0] as AgentOptions;
        expect(options.disallowedTools).toEqual(expect.arrayContaining([`grep`, `glob`, `ls`, `semSearch`, `webFetch`, `readLints`]));
        const crm = options.mcpServers?.[`crm`] as { url: string; headers?: Record<string, string> };
        expect(crm.url).toContain(`/privacy/mcp/`);
        expect(crm.headers).toEqual({ Authorization: `Bearer t` });
        expect(events.filter((event) => event.kind === `delta`).map((event) => (event.kind === `delta` ? event.text : ``)).join(``)).toBe(`Found ${NUMBER}.`);
        // The hooks get the shield, and the instructions carry the note that tells the model what a token is.
        const hook = registered[0] as { shield?: object; systemAppend?: string };
        expect(Object.keys(hook)).toContain(`shield`);
        expect(hook.systemAppend?.startsWith(`Be brief.\n\nPersonal data in this conversation`)).toBe(true);
    });

    // Cursor starts the servers in the project's .cursor/mcp.json with its project settings, unapproved and past the
    // masking proxy; one given in the agent's own options wins its name, so each is given again through the proxy.
    describe("the project's own MCP servers", () => {
        const opened = async (mcp: unknown): Promise<AgentOptions> => {
            create.mockResolvedValue({ agentId: `agent-project-mcp`, send: async () => ({ wait: async () => ({ status: `success` }), cancel }), close: () => {} });
            const turn = await shielded({ prompt: `list the tickets` });
            mkdirSync(join(turn.spec.cwd, `.cursor`));
            writeFileSync(join(turn.spec.cwd, `.cursor`, `mcp.json`), typeof mcp === `string` ? mcp : JSON.stringify(mcp));
            await collect(createCursorAgent(hooked(true))(turn));
            return create.mock.calls.at(-1)?.[0] as AgentOptions;
        };

        test("are reached through the masking proxy under their own names, with their headers filled in", async () => {
            process.env[`INTENTIC_TEST_TICKETS_KEY`] = `k-1`;
            const options = await opened({
                mcpServers: { tickets: { url: `https://tickets.example/mcp`, headers: { Authorization: `Bearer \${env:INTENTIC_TEST_TICKETS_KEY}` } } },
            });
            delete process.env[`INTENTIC_TEST_TICKETS_KEY`];
            const tickets = options.mcpServers?.[`tickets`] as { url: string; headers?: Record<string, string> };
            expect(tickets.url).toContain(`/privacy/mcp/`);
            expect(tickets.headers).toEqual({ Authorization: `Bearer k-1` });
            expect(options.local?.settingSources).toEqual([`mdm`, `project`]);
        });

        test("one that runs as a local process can't be proxied, so the project's settings are not loaded on the turn", async () => {
            const options = await opened({
                mcpServers: { tickets: { url: `https://tickets.example/mcp` }, files: { command: `npx`, args: [`files-mcp`] } },
            });
            expect(options.local?.settingSources).toEqual([`mdm`]);
            expect(options.mcpServers?.[`files`]).toBeUndefined();
        });

        test("a config that can't be read is not loaded either", async () => {
            expect((await opened(`{ not json`)).local?.settingSources).toEqual([`mdm`]);
        });

        test("a project without one loads its settings as always", async () => {
            create.mockResolvedValue({ agentId: `agent-no-mcp`, send: async () => ({ wait: async () => ({ status: `success` }), cancel }), close: () => {} });
            await collect(createCursorAgent(hooked(true))(await shielded({ prompt: `hi` })));
            expect((create.mock.calls.at(-1)?.[0] as AgentOptions).local?.settingSources).toEqual([`mdm`, `project`]);
        });
    });

    test("watching, withholds none of Cursor's tools and adds no note, while still reading what passes", async () => {
        create.mockResolvedValue({
            agentId: `agent-watched`,
            send: async () => ({ wait: async () => ({ status: `success` }), cancel }),
            close: () => {},
        });
        const privacy = await privacySliceFake({ policy: { mode: "watch" } }).privacyShield.forTurn("cursor", "native", "c-1");
        const base = await shielded({ prompt: `PESEL ${NUMBER}`, systemAppend: `Be brief.` });
        await collect(createCursorAgent(hooked(true))({ ...base, hooks: { ...base.hooks, ...(privacy === undefined ? {} : { privacy }) } }));
        const options = create.mock.calls[0]?.[0] as AgentOptions;
        expect(options.disallowedTools).toEqual([`askQuestion`]);
        expect((registered[0] as { systemAppend?: string }).systemAppend).toBe(`Be brief.`);
    });

    test("is refused before anything starts when the shield's hooks into Cursor are not installed", async () => {
        const events = await collect(createCursorAgent(hooked(false))(await shielded()));
        expect(create).not.toHaveBeenCalled();
        expect(events).toEqual([expect.objectContaining({ kind: `error`, code: `privacy-unshielded` }), { kind: `done` }]);
    });

    test("is refused, naming the file, when the rules Cursor loads itself hold personal data", async () => {
        const root = mkdtempSync(join(tmpdir(), `cursor-agent-rules-`));
        writeFileSync(join(root, `AGENTS.md`), `On-call: PESEL ${NUMBER}`);
        const events = await collect(createCursorAgent(hooked(true))(await shielded({ cwd: root })));
        expect(create).not.toHaveBeenCalled();
        const refusal = events[0];
        expect(refusal).toMatchObject({ kind: `error`, code: `privacy-instructions` });
        expect(refusal?.kind === `error` ? refusal.message : ``).toContain(`AGENTS.md holds personal data`);
    });

    // Every message reaches Cursor through the turn's session, which masks it: the feedback typed when rejecting a plan
    // becomes the next planning prompt, a path the first prompt's masking never saw.
    test("masks the feedback that rejects a plan before it is sent as the next planning prompt", async () => {
        const prompts: string[] = [];
        const settle: ((result: { status: string }) => void)[] = [];
        create.mockResolvedValue({
            agentId: `agent-plan-shielded`,
            send: async (prompt: string, options: SendOptions) => {
                prompts.push(prompt);
                options.onDelta?.({ update: { type: `text-delta`, text: `plan ${prompts.length}` } as InteractionUpdate });
                return { wait: () => new Promise((resolve: (result: { status: string }) => void) => settle.push(resolve)), cancel };
            },
            close: () => {},
        });
        const controller = new AbortController();
        const base = await shielded({ prompt: `plan the export` });
        const seen: AgentEvent[] = [];
        const turn = (async () => {
            for await (const event of createCursorAgent(hooked(true))({ ...base, policy: { permissionMode: `plan` }, signal: controller.signal })) {
                seen.push(event);
            }
        })();

        await waitFor(() => expect(settle).toHaveLength(1));
        settle[0]?.({ status: `success` });
        await waitFor(() => expect(seen.some((event) => event.kind === `plan`)).toBe(true));
        const plan = seen.find((event): event is Extract<AgentEvent, { kind: `plan` }> => event.kind === `plan`);
        expect(cards.resolve({ kind: `plan`, requestId: plan?.requestId ?? ``, approve: false, feedback: `use the customer with PESEL ${NUMBER}` })).toBe(`settled`);
        await waitFor(() => expect(prompts).toHaveLength(2));
        controller.abort();
        settle[1]?.({ status: `success` });
        await turn;

        expect(prompts[1]).toContain(`rejected the plan`);
        expect(prompts[1]).toContain(TOKEN);
        expect(prompts[1]).not.toContain(NUMBER);
    });

    // The SDK's Run keeps its methods on its prototype, so the masking session must call them, not copy them.
    test("masks what a live run is steered with, on a run whose methods live on its prototype", async () => {
        const steered: string[] = [];
        let settle: (result: { status: string }) => void = () => {};
        class Run {
            wait(): Promise<{ status: string }> {
                return new Promise((resolve) => {
                    settle = resolve;
                });
            }
            cancel(): Promise<void> {
                return cancel();
            }
            async steer(text: string): Promise<string> {
                steered.push(text);
                return `complete_delivered`;
            }
        }
        create.mockResolvedValue({ agentId: `agent-steered-shielded`, send: async () => new Run(), close: () => {} });
        const steering = new SteeringQueue();
        const turn = collect(createCursorAgent(hooked(true))(await shielded({ prompt: `export the customers`, steering })));
        await waitFor(() => expect(create).toHaveBeenCalled());
        steering.push(`only the one with PESEL ${NUMBER}`);
        await waitFor(() => expect(steered).toHaveLength(1));
        settle({ status: `success` });
        const events = await turn;

        expect(steered).toEqual([`only the one with PESEL ${TOKEN}`]);
        expect(events.filter((event) => event.kind === `error`)).toEqual([]);
    });

    test("sends nothing, and says the turn was unshielded, when a message cannot be masked", async () => {
        const send = jest.fn(async () => ({ wait: async () => ({ status: `success` }), cancel }));
        create.mockResolvedValue({ agentId: `agent-unmasked`, send, close: () => {} });
        const base = await shielded({ prompt: `PESEL ${NUMBER}` });
        const privacy = base.hooks.privacy;
        if (privacy === undefined) {
            throw new Error(`no shield`);
        }
        const failing = {
            ...privacy,
            mask: async () => {
                throw new Error(`reader down`);
            },
        };
        const events = await collect(createCursorAgent(hooked(true))({ ...base, hooks: { ...base.hooks, privacy: failing } }));

        expect(send).not.toHaveBeenCalled();
        expect(events).toContainEqual(expect.objectContaining({ kind: `error`, code: `privacy-unshielded` }));
        expect(events.at(-1)).toEqual({ kind: `done` });
    });
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

// The relay gives a message up the moment it hands it to the run, so a steer the run hands back ("revert_to_followup")
// is the adapter's to deliver: the SDK says to send it as an ordinary follow-up, which is what Codex does with a refused
// steer. Dropping it lost what the person typed while the turn was still running.
test("a steer the run hands back is sent as a follow-up once the run settles, and one it took is not sent again", async () => {
    const prompts: string[] = [];
    const steered: string[] = [];
    const settle: ((result: { status: string }) => void)[] = [];
    create.mockResolvedValue({
        agentId: `agent-steered`,
        send: async (prompt: string) => {
            prompts.push(prompt);
            return {
                wait: () => new Promise((resolve: (result: { status: string }) => void) => settle.push(resolve)),
                cancel,
                steer: async (text: string) => {
                    steered.push(text);
                    return text === `also cover the CLI` ? `complete_delivered` : `revert_to_followup`;
                },
            };
        },
        close: () => {},
    });
    const steering = new SteeringQueue();

    const turn = collect(createCursorAgent(deps())({ ...request(), spec: { ...request().spec, steering } }));
    await waitFor(() => expect(settle).toHaveLength(1));
    steering.push(`also cover the CLI`);
    steering.push(`use SQLite instead`);
    await waitFor(() => expect(steered).toEqual([`also cover the CLI`, `use SQLite instead`]));
    settle[0]?.({ status: `success` });

    await waitFor(() => expect(settle).toHaveLength(2));
    // Admission closed as the run settled: a message from here on is refused at the route, not left unread.
    expect(steering.push(`too late`)).toBe(false);
    settle[1]?.({ status: `success` });
    const events = await turn;

    expect(prompts).toEqual([request().spec.prompt, `use SQLite instead`]);
    expect(events.filter((event) => event.kind === `error`)).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: `done` });
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
const anchored = (base = request(), namespace?: NamespaceEntryReference): AgentRequest<CursorCredential> => ({
    ...base,
    spec: {
        ...base.spec,
        spawnDepth: 1,
        isolation: {
            plan,
            anchor: { pid: namespace?.pid ?? 4321, cwd: WORKSPACE_ROOT, plan, ...(namespace === undefined ? {} : { namespace }), dispose: () => {} },
        },
    },
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

test("Cursor preserves the issued namespace capability to the host without putting it on the runtime wire", async () => {
    const namespace = registerMountEntry(62006);
    const fake = fakeRuntime(oneTurn);
    try {
        const events = await collect(createCursorAgent({ ...deps(), runtime: fake.runtime })(anchored(request(), namespace)));
        expect(fake.spawned).toEqual([{
            command: "nsenter",
            args: [
                "--mount=/proc/62006/ns/mnt", "--wdns=/work", "--", "env", "-u", "PWD", "-u", "OLDPWD",
                "/usr/local/bin/node", "/opt/sandbox/dist/runtimes/cursor/cursor-agent-runtime.js", SDK_ENTRY,
            ],
            spawnDepth: 1,
        }]);
        expect(fake.calls.map((call) => call.method)).toEqual(["open", "send", "wait", "close"]);
        expect(JSON.stringify(fake.calls)).not.toContain(String(namespace.pid));
        expect(events.at(-1)).toEqual({ kind: "done" });
        expect(events.filter((event) => event.kind === "error")).toEqual([]);
    } finally {
        forgetNamespaceEntry(namespace);
    }
});

test("Cursor refuses stale and reconstructed namespace references before spawning a runtime at the reused PID", async () => {
    const reference = registerMountEntry(62007);
    forgetNamespaceEntry(reference);
    const replacement = registerMountEntry(reference.pid);
    const fake = fakeRuntime(oneTurn);
    try {
        for (const namespace of [reference, { ...replacement }]) {
            const events = await collect(createCursorAgent({ ...deps(), runtime: fake.runtime })(anchored(request(), namespace)));
            expect(events).toEqual([{ kind: "error", message: "namespace anchor 62007 reference is not registered" }, { kind: "done" }]);
        }
        expect(fake.spawned).toEqual([]);
        expect(fake.calls).toEqual([]);
    } finally {
        forgetNamespaceEntry(replacement);
    }
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
