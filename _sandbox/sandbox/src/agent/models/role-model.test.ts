import {
    type AgentHarness,
    type AgentProvider,
    type ModelPin,
    capabilitiesOf,
    NATIVE_PROVIDERS,
    type NativeProvider,
} from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import type { PerfFields } from "../../platform/resources/perf.js";
import { PROVIDER_MODULES } from "../../runtimes/runtime-table.js";
import { askRoleModel, REFUSED_FOR_MS } from "./role-model.js";
import { RoleModelUnsetError } from "../../seams/role-model-unset.js";
import { sentenceAnswer } from "./role-answer.js";

// Only the readiness sweep is faked; a provider it leaves unnamed is one that cannot run.
const ready = jest.fn<() => Promise<Partial<Record<NativeProvider, boolean>>>>();
const readiness = async (): Promise<Record<NativeProvider, boolean>> => {
    const named = await ready();
    return Object.fromEntries(NATIVE_PROVIDERS.map((provider) => [provider, named[provider] === true])) as Record<NativeProvider, boolean>;
};

// Faked at the adapter seam, keyed by runtime, so a test can tell which loop a rung took.
const oneShot = jest.fn<(ask: { model: string }) => Promise<string>>();
const geminiOneShot = jest.fn<(ask: { model: string }) => Promise<string>>();
const cursorOneShot = jest.fn<(ask: { model: string }) => Promise<string>>();
const runners: Record<string, (ask: { model: string }) => Promise<string>> = {
    "claude-code": (ask) => oneShot(ask),
    "opencode-gemini": (ask) => geminiOneShot(ask),
    cursor: (ask) => cursorOneShot(ask),
};
type Adapter = ReturnType<Services[`adapters`][`for`]>;
// A runtime with no runner here is one that runs no helper, so its adapter carries no `oneShot` at all.
const adapterFor = (provider: AgentProvider, harness: AgentHarness): Adapter => {
    const runtime = capabilitiesOf(provider, harness).runtime;
    const run = runners[runtime];
    const unasked = unstubbed<Adapter>(`adapters.${runtime}`, {});
    return {
        runtime,
        preflight: unasked.preflight,
        health: unasked.health,
        holdsSession: unasked.holdsSession,
        ...(run === undefined ? {} : { oneShot: (_deps: unknown, ask: { model: string }) => run(ask) }),
    };
};

// Thinnest answer contract (accepts any ordinary commit subject), so these tests exercise the walk, not the reply
// shape.
const DRAFT = { prompt: `draft`, answer: sentenceAnswer(`a commit subject`, (reply: string) => reply.trim(), 20) };

// The contract decides order (its own suite pins that); these tests cover only what the daemon does: step past a
// refusal and ask the next rung automatically.

// Two providers connected: enough for a pin to name a chain and for Auto to have a second rung.
const CATALOGS: Record<string, readonly string[]> = {
    claude: [`claude-opus-5`, `claude-haiku-4-5`],
    gemini: [`gemini-3-flash-lite`],
    codex: [`gpt-5.6`],
    cursor: [`composer-2.5`],
};

// Default: nothing spent. ROLE is `commit-message` throughout since the walk is the same for any role.
const ROLE = `commit-message` as const;

const asPins = (keys: readonly string[]): ModelPin[] =>
    keys.map((key) => ({ provider: key.slice(0, key.indexOf(`:`)), model: key.slice(key.indexOf(`:`) + 1) }));

const fakeServices = (pinned: readonly string[], spent: readonly string[] = []): Services =>
    unstubbed<Services>(`services`, {
        providerReadiness: readiness,
        adapters: { for: adapterFor, all: [] },
        sandboxSettings: unstubbed<Services[`sandboxSettings`]>(`sandboxSettings`, {
            get: async () => ({ modelRoles: { [ROLE]: asPins(pinned) } }) as Awaited<ReturnType<Services[`sandboxSettings`][`get`]>>,
        }),
        capabilities: unstubbed<Services[`capabilities`]>(`capabilities`, { list: async () => [] }),
        // The real modules, so a provider keeping its own allowance reading answers for itself.
        providerModules: PROVIDER_MODULES,
        cliProxy: unstubbed<Services[`cliProxy`]>(`cliProxy`, {
            turnLimit: async (provider) => (spent.includes(provider) ? { spent: 1, withHeadroom: 0 } : { spent: 0, withHeadroom: 1 }),
        }),
        claudeStore: unstubbed<Services[`claudeStore`]>(`claudeStore`, {
            list: async () => [{ id: `claude-one` }] as Awaited<ReturnType<Services[`claudeStore`][`list`]>>,
        }),
        accountUsage: unstubbed<Services[`accountUsage`]>(`accountUsage`, {
            read: async () => ({
                "claude-one": { windows: [{ kind: `seven_day`, utilization: spent.includes(`claude`) ? 100 : 4, gates: `all` }], measuredAt: 0 },
            }),
        }),
        providerCatalogs: Object.fromEntries(
            Object.entries(CATALOGS).map(([provider, models]) => [provider, { models: async () => ({ models: models.map((id) => ({ id })) }) }]),
        ) as Services[`providerCatalogs`],
        workspace: unstubbed<Services[`workspace`]>(`workspace`, { root: `/work` }),
        logger: unstubbed<Services[`logger`]>(`logger`, { debug: () => {} }),
        // Records each rung's timing under its model name for the walk's perf trace.
        perf: unstubbed<Services[`perf`]>(`perf`, { record: (op, ms, fields, failed) => void timed.push({ op, ms, fields, failed }) }),
    });

const signal = (): AbortSignal => new AbortController().signal;

// One entry per model actually asked, in spend order; typed from perf's own record signature.
type Billed = { op: string; ms: number; fields: PerfFields; failed?: boolean | undefined };
const timed: Billed[] = [];

// Refusal memo persists as module state; each test starts a memo-length past the last, so nothing bleeds over.
const BETWEEN_TESTS_MS = REFUSED_FOR_MS + 60 * 60 * 1000;
// Just past the memo window, for tests that check it expiring.
const PAST_THE_MEMO_MS = REFUSED_FOR_MS + 60 * 1000;
let clock = 1_700_000_000_000;

beforeEach(() => {
    clock += BETWEEN_TESTS_MS;
    jest.setSystemTime(new Date(clock));
    // Reset all mocks so queued one-shot failures cannot leak between tests.
    jest.resetAllMocks();
    timed.length = 0;
    ready.mockResolvedValue({ claude: true, gemini: true, codex: true, cursor: true });
    oneShot.mockResolvedValue(`fix: tree truncation`);
    geminiOneShot.mockResolvedValue(`fix: tree truncation`);
    cursorOneShot.mockResolvedValue(`fix: tree truncation`);
});

afterEach(() => {
    jest.useRealTimers();
});

test("spends the first model in the order and reports nothing skipped", async () => {
    const answer = await askRoleModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), ROLE, DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(answer.skipped).toEqual([]);
    expect(oneShot).toHaveBeenCalledTimes(1);
});

test("steps over a spent allowance and answers on the next model down", async () => {
    oneShot.mockRejectedValueOnce(new Error(`ChatGPT usage limit reached: the allowance is exhausted.`));

    const answer = await askRoleModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), ROLE, DRAFT, signal());

    expect(answer.value).toBe(`fix: tree truncation`);
    expect(answer.choice).toEqual({ provider: `claude`, model: `claude-haiku-4-5` });
    expect(answer.skipped).toEqual([{ choice: { provider: `codex`, model: `gpt-5.6` }, reason: expect.stringContaining(`usage limit`) }]);
});

test("treats a credential that fails on the way in as one more refusal to step over", async () => {
    // A token that fails at resolution passes the cheap readiness check first; the next account must still answer.
    oneShot.mockRejectedValueOnce(new Error(`Reconnect your ChatGPT account.`));

    const answer = await askRoleModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), ROLE, DRAFT, signal());

    expect(answer.choice.provider).toBe(`claude`);
    expect(answer.skipped[0]?.reason).toMatch(/ChatGPT|Reconnect/i);
});

test("names every model it asked when the whole chain is spent", async () => {
    oneShot.mockRejectedValue(new Error(`usage limit reached`));

    await expect(askRoleModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), ROLE, DRAFT, signal())).rejects.toThrow(
        /gpt-5\.6.*claude-haiku-4-5/,
    );
});

test("stops the moment the user cancels rather than spending the rest of the chain", async () => {
    const controller = new AbortController();
    oneShot.mockImplementationOnce(async () => {
        controller.abort();
        throw new Error(`aborted`);
    });

    await expect(askRoleModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), ROLE, DRAFT, controller.signal)).rejects.toThrow(`aborted`);
    expect(oneShot).toHaveBeenCalledTimes(1);
});

test("asks nothing at all when no model is set for the job", async () => {
    const thrown = await askRoleModel(fakeServices([]), ROLE, DRAFT, signal()).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(RoleModelUnsetError);
    expect((thrown as Error).message).toBe(`No model is set for this job, so it does not run. Set one in Sandbox ▸ Agent ▸ Models.`);
    expect((thrown as InstanceType<typeof RoleModelUnsetError>).role).toBe(ROLE);
    expect(oneShot).not.toHaveBeenCalled();
    expect(geminiOneShot).not.toHaveBeenCalled();
    expect(cursorOneShot).not.toHaveBeenCalled();
});

test("spends the list belonging to the role that asked, not another role's", async () => {
    const services = unstubbed<Services>(`services`, {
        ...fakeServices([`gemini:gemini-3-flash-lite`]),
        sandboxSettings: unstubbed<Services[`sandboxSettings`]>(`sandboxSettings`, {
            get: async () =>
                ({
                    modelRoles: { [ROLE]: asPins([`gemini:gemini-3-flash-lite`]), "safety-judge": asPins([`claude:claude-opus-5`]) },
                }) as Awaited<ReturnType<Services[`sandboxSettings`][`get`]>>,
        }),
    });

    expect((await askRoleModel(services, `safety-judge`, DRAFT, signal())).choice).toEqual({ provider: `claude`, model: `claude-opus-5` });
    expect(geminiOneShot).not.toHaveBeenCalled();
});

test("walks the pins a caller snapshotted instead of re-reading the role's list", async () => {
    const answer = await askRoleModel(fakeServices([`gemini:gemini-3-flash-lite`]), ROLE, DRAFT, signal(), {
        pins: asPins([`claude:claude-opus-5`]),
    });

    expect(answer.choice).toEqual({ provider: `claude`, model: `claude-opus-5` });
    expect(geminiOneShot).not.toHaveBeenCalled();
});

// Settings still has `codex:gpt-5.6` for this role, but an empty pins snapshot refuses rather than falling back to it.
test("refuses on the snapshot it was handed rather than re-reading the role's list", async () => {
    const thrown = await askRoleModel(fakeServices([`codex:gpt-5.6`]), ROLE, DRAFT, signal(), { pins: [] }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(RoleModelUnsetError);
    expect((thrown as Error).message).toBe(`No model is set for this job, so it does not run. Set one in Sandbox ▸ Agent ▸ Models.`);
    expect(oneShot).not.toHaveBeenCalled();
});

test("says the job's accounts have gone rather than failing on a model call", async () => {
    ready.mockResolvedValue({ claude: false, gemini: false, codex: false });

    const thrown = await askRoleModel(fakeServices([`claude:claude-haiku-4-5`]), ROLE, DRAFT, signal()).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(RoleModelUnsetError);
    expect((thrown as Error).message).toBe(
        `Every model set for this job names an account this sandbox no longer has: set one in Sandbox ▸ Agent ▸ Models.`,
    );
    expect(oneShot).not.toHaveBeenCalled();
});

test("a model that just refused is stepped over without being asked again", async () => {
    const pinned = [`codex:gpt-5.6`, `claude:claude-haiku-4-5`];
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));
    await askRoleModel(fakeServices(pinned), ROLE, DRAFT, signal());
    expect(oneShot).toHaveBeenCalledTimes(2);

    oneShot.mockClear();
    const answer = await askRoleModel(fakeServices(pinned), ROLE, DRAFT, signal());

    expect(oneShot).toHaveBeenCalledTimes(1);
    expect(oneShot).toHaveBeenCalledWith(expect.objectContaining({ model: `claude-haiku-4-5` }));
    expect(answer.skipped).toEqual([{ choice: { provider: `codex`, model: `gpt-5.6` }, reason: expect.stringContaining(`usage limit`) }]);
});

test("asks it again once the memo has run out: an allowance resets and nothing announces it", async () => {
    const pinned = [`codex:gpt-5.6`, `claude:claude-haiku-4-5`];
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));
    await askRoleModel(fakeServices(pinned), ROLE, DRAFT, signal());

    jest.setSystemTime(new Date(clock + PAST_THE_MEMO_MS));
    oneShot.mockClear();
    const answer = await askRoleModel(fakeServices(pinned), ROLE, DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(answer.skipped).toEqual([]);
});

test("an answer clears the memo, so a recovered model keeps its place at the top", async () => {
    const pinned = [`codex:gpt-5.6`, `claude:claude-haiku-4-5`];
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));
    await askRoleModel(fakeServices(pinned), ROLE, DRAFT, signal());

    jest.setSystemTime(new Date(clock + PAST_THE_MEMO_MS));
    await askRoleModel(fakeServices(pinned), ROLE, DRAFT, signal());
    oneShot.mockClear();
    const answer = await askRoleModel(fakeServices(pinned), ROLE, DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(oneShot).toHaveBeenCalledTimes(1);
});

test("tries the whole chain anyway when every rung is cooling down", async () => {
    const pinned = [`codex:gpt-5.6`, `claude:claude-haiku-4-5`];
    oneShot.mockRejectedValue(new Error(`usage limit reached`));
    await expect(askRoleModel(fakeServices(pinned), ROLE, DRAFT, signal())).rejects.toThrow();

    oneShot.mockClear();
    oneShot.mockResolvedValue(`fix: tree truncation`);
    const answer = await askRoleModel(fakeServices(pinned), ROLE, DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(oneShot).toHaveBeenCalledTimes(1);
});

test("steps over a rung that writes a tool call instead of an answer", async () => {
    oneShot.mockResolvedValueOnce(`[tool_call: glob for pattern '**']`);

    const answer = await askRoleModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), ROLE, DRAFT, signal());

    expect(answer.value).toBe(`fix: tree truncation`);
    expect(answer.choice).toEqual({ provider: `claude`, model: `claude-haiku-4-5` });
    expect(answer.skipped).toEqual([{ choice: { provider: `codex`, model: `gpt-5.6` }, reason: expect.stringContaining(`tool call`) }]);
});

test("an unusable reply leaves no memo: the same rung is asked again on the next call", async () => {
    const pinned = [`codex:gpt-5.6`, `claude:claude-haiku-4-5`];
    oneShot.mockResolvedValueOnce(`[tool_call: glob for pattern '**']`);
    await askRoleModel(fakeServices(pinned), ROLE, DRAFT, signal());

    oneShot.mockClear();
    const answer = await askRoleModel(fakeServices(pinned), ROLE, DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(oneShot).toHaveBeenCalledTimes(1);
    expect(answer.skipped).toEqual([]);
});

test("names what every rung wrote when none of them wrote an answer", async () => {
    oneShot.mockResolvedValue(`I need more context. What am I naming?`);
    geminiOneShot.mockResolvedValue(`I need more context. What am I naming?`);

    await expect(askRoleModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), ROLE, DRAFT, signal())).rejects.toThrow(
        /gpt-5\.6: answered the asker.*claude-haiku-4-5: answered the asker/,
    );
});

// Google's Antigravity channel refuses the Claude Code harness's Anthropic identity line and reports it as a spent
// quota, so a Gemini rung must never run that loop.

test("runs a Cursor rung on its own runtime, never through the Claude Code harness", async () => {
    const answer = await askRoleModel(fakeServices([`cursor:composer-2.5`]), ROLE, DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `cursor`, model: `composer-2.5` });
    expect(cursorOneShot).toHaveBeenCalledWith(expect.objectContaining({ model: `composer-2.5` }));
    expect(oneShot).not.toHaveBeenCalled();
});

test("runs a Gemini rung on its own runtime, never through the Claude Code harness", async () => {
    const answer = await askRoleModel(fakeServices([`gemini:gemini-3-flash-lite`]), ROLE, DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `gemini`, model: `gemini-3-flash-lite` });
    expect(geminiOneShot).toHaveBeenCalledWith(expect.objectContaining({ model: `gemini-3-flash-lite` }));
    expect(oneShot).not.toHaveBeenCalled();
});

test("keeps every other provider on the Claude Code harness", async () => {
    await askRoleModel(fakeServices([`codex:gpt-5.6`]), ROLE, DRAFT, signal());

    expect(oneShot).toHaveBeenCalledWith(expect.objectContaining({ model: `gpt-5.6` }));
    expect(geminiOneShot).not.toHaveBeenCalled();
    expect(cursorOneShot).not.toHaveBeenCalled();
});

test("steps over a rung the recorded quota already says is spent", async () => {
    const answer = await askRoleModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`], [`codex`]), ROLE, DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `claude`, model: `claude-haiku-4-5` });
    expect(oneShot).toHaveBeenCalledTimes(1);
    expect(oneShot).not.toHaveBeenCalledWith(expect.objectContaining({ model: `gpt-5.6` }));
    expect(answer.skipped).toEqual([{ choice: { provider: `codex`, model: `gpt-5.6` }, reason: expect.stringContaining(`out of allowance`) }]);
});

test("a rung with headroom on file is asked, whatever the rest of the fleet looks like", async () => {
    const answer = await askRoleModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), ROLE, DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(answer.skipped).toEqual([]);
});

test("asks every rung anyway when the quota says the whole chain is spent", async () => {
    const answer = await askRoleModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`], [`codex`, `claude`]), ROLE, DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(oneShot).toHaveBeenCalledTimes(1);
    expect(answer.skipped).toEqual([]);
});

test("a cancel leaves no memo behind", async () => {
    const controller = new AbortController();
    oneShot.mockImplementationOnce(async () => {
        controller.abort();
        throw new Error(`aborted`);
    });
    await expect(askRoleModel(fakeServices([`codex:gpt-5.6`]), ROLE, DRAFT, controller.signal)).rejects.toThrow(`aborted`);

    oneShot.mockClear();
    const answer = await askRoleModel(fakeServices([`codex:gpt-5.6`]), ROLE, DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(oneShot).toHaveBeenCalledTimes(1);
});

// `skipped` lists only rungs the walk passed on its way to an answer, not ones behind it that were never reached.
test("does not report a cooling rung that sits behind the model that answered", async () => {
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));
    await askRoleModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), ROLE, DRAFT, signal());

    const answer = await askRoleModel(fakeServices([`claude:claude-haiku-4-5`, `codex:gpt-5.6`]), ROLE, DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `claude`, model: `claude-haiku-4-5` });
    expect(answer.skipped).toEqual([]);
});

test("tells a listener every beat: asking, the refusal in its own words, and the answer", async () => {
    const beats: string[] = [];
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));

    await askRoleModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), ROLE, DRAFT, signal(), {
        onProgress: (attempts) => beats.push(attempts.map((attempt) => `${attempt.choice.model}:${attempt.status}`).join(` `)),
    });

    expect(beats).toEqual([
        `gpt-5.6:asking`,
        `gpt-5.6:refused`,
        `gpt-5.6:refused claude-haiku-4-5:asking`,
        `gpt-5.6:refused claude-haiku-4-5:answered`,
    ]);
});

test("a rung skipped on its memo is a beat too, with the remembered reason, and a listener's throw costs the walk nothing", async () => {
    const pinned = [`codex:gpt-5.6`, `claude:claude-haiku-4-5`];
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));
    await askRoleModel(fakeServices(pinned), ROLE, DRAFT, signal());

    const beats: { model: string; status: string; reason?: string | undefined }[] = [];
    oneShot.mockClear();
    const answer = await askRoleModel(fakeServices(pinned), ROLE, DRAFT, signal(), {
        onProgress: (attempts) => {
            beats.push(...attempts.slice(beats.length > 0 ? -1 : 0).map((a) => ({ model: a.choice.model, status: a.status, reason: a.reason })));
            throw new Error(`a broken listener`);
        },
    });

    expect(answer.value).toBe(`fix: tree truncation`);
    expect(beats[0]).toEqual({ model: `gpt-5.6`, status: `skipped`, reason: `usage limit reached` });
});

test("bills every model it asks, by name, answered or refused", async () => {
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));

    await askRoleModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), ROLE, DRAFT, signal());

    expect(timed.map((entry) => [entry.op, entry.fields[`model`], entry.failed])).toEqual([
        [`role.model`, `gpt-5.6`, true],
        [`role.model`, `claude-haiku-4-5`, undefined],
    ]);
});

// A rung whose declared window cannot hold the ask. Sending it anyway costs a round trip, earns a ten-minute memo and
// comes back as the server's raw 400, so the same job reads as intermittent rather than as mis-sized.

// The fixture above has no endpoints; this adds one that publishes a window, which is the only kind of rung that can
// declare one at all (a native subscription publishes none).
const withEndpoint = (pinned: readonly string[], window: number): Services => {
    const card = { id: `tiny`, kind: `localmodel` as const, config: { model: `x/llama.gguf`, gpu: `off` as const, context: `16384` as const } };
    const base = fakeServices(pinned);
    return unstubbed<Services>(`services`, {
        ...base,
        capabilities: unstubbed<Services[`capabilities`]>(`capabilities`, { list: async () => [card], get: async () => card }),
        endpointModels: unstubbed<Services[`endpointModels`]>(`endpointModels`, {
            models: async () => ({ models: [{ id: `llama`, label: `llama`, contextWindow: window }], default: `llama` }),
        }),
    });
};

test("a rung too small for the ask is stepped over, and the next one answers", async () => {
    const services = withEndpoint([`endpoint/tiny:llama`, `claude:claude-opus-5`], 16_384);
    const big = { ...DRAFT, prompt: `x`.repeat(200_000) };

    const answer = await askRoleModel(services, ROLE, big, signal());

    // The small rung was never asked: no round trip, no memo, no raw 400.
    expect(timed.map((billed) => billed.fields[`model`])).toEqual([`claude-opus-5`]);
    expect(answer.choice.model).toBe(`claude-opus-5`);
    const reason = answer.skipped.find((refusal) => refusal.choice.model === `llama`)?.reason;
    expect(reason).toContain(`16,384`);
    expect(reason).toContain(`Sandbox ▸ Agent ▸ Models`);
});

// The other half of the same mechanism: an ask that can size itself is handed the room instead of being refused.
test("an ask that sizes itself is built for the rung's own room and asked", async () => {
    const services = withEndpoint([`endpoint/tiny:llama`], 16_384);
    const rooms: number[] = [];
    const sizing = {
        ...DRAFT,
        prompt: (room: number): string => {
            rooms.push(room);
            return `x`.repeat(Math.min(room, 200_000));
        },
    };

    const answer = await askRoleModel(services, ROLE, sizing, signal());

    expect(answer.choice.model).toBe(`llama`);
    // 16,384 window − 1,000 reply = 15,384 tokens × 4 chars: the whole window bar room to answer, since a one-shot
    // carries no tools.
    expect(rooms).toEqual([15_384 * 4]);
});

// A native provider publishes no window, so nothing is measured and a fixed prompt of any size still goes.
test("an unknown window is asked whatever the prompt's size", async () => {
    const services = fakeServices([`claude:claude-opus-5`]);

    const answer = await askRoleModel(services, ROLE, { ...DRAFT, prompt: `x`.repeat(500_000) }, signal());

    expect(answer.choice.model).toBe(`claude-opus-5`);
});
