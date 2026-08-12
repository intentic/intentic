import { unstubbed } from "@intentic/testing";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import type { PerfFields } from "../platform/perf.js";

const ready = vi.fn<() => Promise<Record<string, boolean>>>();
const credentials = vi.fn<(services: Services, target: { agent: string; model: string }) => Promise<{ ok: boolean; message?: string }>>();
vi.mock("./harness-credentials.js", () => ({
    harnessReadyProviders: () => ready(),
    resolveHarnessCredentials: (services: Services, target: { agent: string; model: string }) => credentials(services, target),
}));

const oneShot = vi.fn<(params: { model: string }) => Promise<string>>();
vi.mock("./one-shot.js", () => ({ runOneShot: (params: { model: string }) => oneShot(params) }));

const { askQuickModel } = await import("./quick-model.js");

/* WALKING THE CHAIN — the daemon half of the ordered quick model. The contract decides the ORDER (its own
 * suite pins that); what is testable here is the part only the daemon can do, which is notice that a model
 * refused and ask the next one instead of handing the user a button that did nothing. */

// Two Claude rows and one Gemini row, both providers connected — enough for a pin to name a chain and for Auto
// to have a second rung. Every catalog read here is a cached one in production, so asking for all of them is
// the cheap part.
const CATALOGS: Record<string, readonly string[]> = {
    claude: [`claude-opus-5`, `claude-haiku-4-5`],
    gemini: [`gemini-3-flash-lite`],
    codex: [`gpt-5.6`],
};

const fakeServices = (quickModel: readonly string[]): Services =>
    unstubbed<Services>(`services`, {
        sandboxSettings: unstubbed<Services[`sandboxSettings`]>(`sandboxSettings`, {
            get: async () => ({ quickModel: [...quickModel] }) as Awaited<ReturnType<Services[`sandboxSettings`][`get`]>>,
        }),
        capabilities: unstubbed<Services[`capabilities`]>(`capabilities`, { list: async () => [] }),
        providerCatalogs: Object.fromEntries(
            Object.entries(CATALOGS).map(([provider, models]) => [provider, { models: async () => ({ models: models.map((id) => ({ id })) }) }]),
        ) as Services[`providerCatalogs`],
        workspace: unstubbed<Services[`workspace`]>(`workspace`, { root: `/work` }),
        logger: unstubbed<Services[`logger`]>(`logger`, { debug: () => {} }),
        // Every rung the walk asks is timed and named here, which is how "the helper got slow" becomes "this
        // model got slow" without anybody watching processes by hand.
        perf: unstubbed<Services[`perf`]>(`perf`, { record: (op, ms, fields, failed) => void timed.push({ op, ms, fields, failed }) }),
    });

const signal = (): AbortSignal => new AbortController().signal;

// What the walk billed, in the order it spent it — one entry per model actually asked. Typed off the tracker's
// own signature rather than a lookalike, so a record the walk makes and this cannot hold is a type error here.
type Billed = { op: string; ms: number; fields: PerfFields; failed?: boolean | undefined };
const timed: Billed[] = [];

/* The refusal memo is module state that outlives a call ON PURPOSE — that is the whole feature — so the clock
 * is what separates the tests rather than a reset hatch the daemon would never have. Each one starts an hour
 * after the last, by which time anything the previous test left has long expired. Only `Date` is faked: this
 * path has no timers of its own, and faking those would only get in the way of the promises it does have. */
const HOUR_MS = 60 * 60 * 1000;
let clock = 1_700_000_000_000;

beforeEach(() => {
    vi.useFakeTimers({ toFake: [`Date`] });
    clock += HOUR_MS;
    vi.setSystemTime(clock);
    vi.clearAllMocks();
    timed.length = 0;
    ready.mockResolvedValue({ claude: true, gemini: true, codex: true });
    credentials.mockResolvedValue({ ok: true });
    oneShot.mockResolvedValue(`fix: tree truncation`);
});

afterEach(() => {
    vi.useRealTimers();
});

test("spends the first model in the order and reports nothing skipped", async () => {
    const answer = await askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), `draft`, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(answer.skipped).toEqual([]);
    expect(oneShot).toHaveBeenCalledTimes(1);
});

test("steps over a spent allowance and answers on the next model down", async () => {
    // The case the whole feature exists for: the account the chat has been running on all afternoon is out, and
    // a commit message is not worth waiting six hours for.
    oneShot.mockRejectedValueOnce(new Error(`ChatGPT usage limit reached — the allowance is exhausted.`));

    const answer = await askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), `draft`, signal());

    expect(answer.text).toBe(`fix: tree truncation`);
    expect(answer.choice).toEqual({ provider: `claude`, model: `claude-haiku-4-5` });
    expect(answer.skipped).toEqual([{ choice: { provider: `codex`, model: `gpt-5.6` }, reason: expect.stringContaining(`usage limit`) }]);
});

test("treats a credential that fails on the way in as one more refusal to step over", async () => {
    // A token that no longer refreshes passes the cheap readiness check and dies at resolution. From the user's
    // side that is the same dead end as a spent allowance, and the next account answers both.
    credentials.mockResolvedValueOnce({ ok: false, message: `Reconnect your ChatGPT account.` });

    const answer = await askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), `draft`, signal());

    expect(answer.choice.provider).toBe(`claude`);
    expect(answer.skipped[0]?.reason).toBe(`Reconnect your ChatGPT account.`);
});

test("names every model it asked when the whole chain is spent", async () => {
    // "Couldn't draft a commit message" on its own is indistinguishable from a broken button. What the user
    // needs is which accounts were tried and what each one said.
    oneShot.mockRejectedValue(new Error(`usage limit reached`));

    await expect(askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), `draft`, signal())).rejects.toThrow(
        /gpt-5\.6.*claude-haiku-4-5/,
    );
});

test("stops the moment the user cancels rather than spending the rest of the chain", async () => {
    const controller = new AbortController();
    oneShot.mockImplementationOnce(async () => {
        controller.abort();
        throw new Error(`aborted`);
    });

    await expect(askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), `draft`, controller.signal)).rejects.toThrow(`aborted`);
    expect(oneShot).toHaveBeenCalledTimes(1);
});

test("falls through Auto's own ladder when nothing is pinned", async () => {
    // Auto is an order too, so a sandbox with three accounts keeps its commit messages when the cheapest one is
    // out — without anybody having opened the settings row.
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));

    const answer = await askQuickModel(fakeServices([]), `draft`, signal());

    expect(answer.skipped).toHaveLength(1);
    expect(answer.choice.provider).not.toBe(answer.skipped[0]?.choice.provider);
});

test("says the sandbox has no account rather than failing on a model call", async () => {
    ready.mockResolvedValue({ claude: false, gemini: false, codex: false });

    await expect(askQuickModel(fakeServices([`claude:claude-haiku-4-5`]), `draft`, signal())).rejects.toThrow(/No AI account is connected/);
    expect(oneShot).not.toHaveBeenCalled();
});

/* NOT PAYING TWICE FOR THE SAME REFUSAL. What this is worth was measured on a real workspace: a first-pinned
 * model that answered nothing burned 58 seconds before the chain reached one that answered in 7 — and it burned
 * them again on the next landing, and the one after, because the walk started from the top every time. */

test("a model that just refused is stepped over without being asked again", async () => {
    const pinned = [`codex:gpt-5.6`, `claude:claude-haiku-4-5`];
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));
    await askQuickModel(fakeServices(pinned), `draft`, signal());
    expect(oneShot).toHaveBeenCalledTimes(2); // the refusal, then the model that answered

    oneShot.mockClear();
    const answer = await askQuickModel(fakeServices(pinned), `draft`, signal());

    expect(oneShot).toHaveBeenCalledTimes(1);
    expect(oneShot).toHaveBeenCalledWith(expect.objectContaining({ model: `claude-haiku-4-5` }));
    // …and the account it did not spend is still accounted for, in the words that account itself last used.
    expect(answer.skipped).toEqual([{ choice: { provider: `codex`, model: `gpt-5.6` }, reason: expect.stringContaining(`usage limit`) }]);
});

test("asks it again once the memo has run out — an allowance resets and nothing announces it", async () => {
    const pinned = [`codex:gpt-5.6`, `claude:claude-haiku-4-5`];
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));
    await askQuickModel(fakeServices(pinned), `draft`, signal());

    vi.setSystemTime(clock + 6 * 60 * 1000);
    oneShot.mockClear();
    const answer = await askQuickModel(fakeServices(pinned), `draft`, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(answer.skipped).toEqual([]);
});

test("an answer clears the memo, so a recovered model keeps its place at the top", async () => {
    const pinned = [`codex:gpt-5.6`, `claude:claude-haiku-4-5`];
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));
    await askQuickModel(fakeServices(pinned), `draft`, signal());

    // The window ends, it answers, and the walk must not go back to skipping it a moment later.
    vi.setSystemTime(clock + 6 * 60 * 1000);
    await askQuickModel(fakeServices(pinned), `draft`, signal());
    oneShot.mockClear();
    const answer = await askQuickModel(fakeServices(pinned), `draft`, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(oneShot).toHaveBeenCalledTimes(1);
});

// The memo saves time; it may never be the reason nothing gets asked at all. Every rung cooling down at once is
// exactly when a helper must still try — that is the state the chain exists for.
test("tries the whole chain anyway when every rung is cooling down", async () => {
    const pinned = [`codex:gpt-5.6`, `claude:claude-haiku-4-5`];
    oneShot.mockRejectedValue(new Error(`usage limit reached`));
    await expect(askQuickModel(fakeServices(pinned), `draft`, signal())).rejects.toThrow();

    oneShot.mockClear();
    oneShot.mockResolvedValue(`fix: tree truncation`);
    const answer = await askQuickModel(fakeServices(pinned), `draft`, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(oneShot).toHaveBeenCalledTimes(1);
});

// A user who stopped the loop stopped this call; the model did nothing wrong and must not be skipped next time.
test("a cancel leaves no memo behind", async () => {
    const controller = new AbortController();
    oneShot.mockImplementationOnce(async () => {
        controller.abort();
        throw new Error(`aborted`);
    });
    await expect(askQuickModel(fakeServices([`codex:gpt-5.6`]), `draft`, controller.signal)).rejects.toThrow(`aborted`);

    oneShot.mockClear();
    const answer = await askQuickModel(fakeServices([`codex:gpt-5.6`]), `draft`, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(oneShot).toHaveBeenCalledTimes(1);
});

// `skipped` is what stood between the caller and the answer, so a cooling rung the walk never got as far as is
// not one of them — reporting it would tell the user an account was passed over when it was simply not needed.
test("does not report a cooling rung that sits behind the model that answered", async () => {
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));
    await askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), `draft`, signal());

    const answer = await askQuickModel(fakeServices([`claude:claude-haiku-4-5`, `codex:gpt-5.6`]), `draft`, signal());

    expect(answer.choice).toEqual({ provider: `claude`, model: `claude-haiku-4-5` });
    expect(answer.skipped).toEqual([]);
});

/* THE LIVE VIEW OF THE WALK — every beat re-told whole, which is what the Changes panel's draft report renders.
 * The order pinned here IS the user-visible timeline: asked, refused with the reason, asked the next, answered. */
test("tells a listener every beat: asking, the refusal in its own words, and the answer", async () => {
    const beats: string[] = [];
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));

    await askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), `draft`, signal(), (attempts) =>
        beats.push(attempts.map((attempt) => `${attempt.choice.model}:${attempt.status}`).join(` `)),
    );

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
    await askQuickModel(fakeServices(pinned), `draft`, signal());

    const beats: { model: string; status: string; reason?: string | undefined }[] = [];
    oneShot.mockClear();
    const answer = await askQuickModel(fakeServices(pinned), `draft`, signal(), (attempts) => {
        beats.push(...attempts.slice(beats.length > 0 ? -1 : 0).map((a) => ({ model: a.choice.model, status: a.status, reason: a.reason })));
        throw new Error(`a broken listener`);
    });

    expect(answer.text).toBe(`fix: tree truncation`);
    expect(beats[0]).toEqual({ model: `gpt-5.6`, status: `skipped`, reason: `usage limit reached` });
});

/* WHICH MODEL TOOK THE TIME — the question the caller's own timing cannot answer, and the one that had to be
 * answered by watching CLI processes by hand. */
test("bills every model it asks, by name, answered or refused", async () => {
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));

    await askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), `draft`, signal());

    expect(timed.map((entry) => [entry.op, entry.fields[`model`], entry.failed])).toEqual([
        [`quick.model`, `gpt-5.6`, true],
        [`quick.model`, `claude-haiku-4-5`, undefined],
    ]);
});
