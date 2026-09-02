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

/* THE OTHER ROAD TO A MODEL, mocked separately from the one above precisely so the tests can tell which one a
 * rung took. Google refuses the Claude Code harness outright (see askRung), so "which loop ran this" is a
 * correctness property of the walk here, not an implementation detail. */
const geminiOneShot = vi.fn<(params: { model: string }) => Promise<string>>();
vi.mock("./one-shot-gemini.js", () => ({ runGeminiOneShot: (params: { model: string }) => geminiOneShot(params) }));

const cursorOneShot = vi.fn<(params: { model: string }) => Promise<string>>();
vi.mock("./one-shot-cursor.js", () => ({ runCursorOneShot: (params: { model: string }) => cursorOneShot(params) }));

const { askQuickModel, REFUSED_FOR_MS } = await import("./quick-model.js");
const { sentenceAnswer } = await import("./quick-answer.js");

/* WHAT THESE TESTS ASK FOR. Every ask carries the contract its reply is read against (quick-answer.ts, which has
 * its own suite for what makes a reply usable); this is the thinnest one that accepts an ordinary commit
 * subject, so a test about the WALK never turns on the shape of a mocked reply. */
const DRAFT = { prompt: `draft`, answer: sentenceAnswer(`a commit subject`, (reply: string) => reply.trim(), 20) };

/* WALKING THE CHAIN: the daemon half of the ordered quick model. The contract decides the ORDER (its own
 * suite pins that); what is testable here is the part only the daemon can do, which is notice that a model
 * refused and ask the next one instead of handing the user a button that did nothing. */

// Two Claude rows and one Gemini row, both providers connected: enough for a pin to name a chain and for Auto
// to have a second rung. Every catalog read here is a cached one in production, so asking for all of them is
// the cheap part.
const CATALOGS: Record<string, readonly string[]> = {
    claude: [`claude-opus-5`, `claude-haiku-4-5`],
    gemini: [`gemini-3-flash-lite`],
    codex: [`gpt-5.6`],
    cursor: [`composer-2.5`],
};

/* WHICH PROVIDERS' ACCOUNTS THE RECORDED QUOTA SAYS ARE SPENT. The reading itself has its own suite next door
 * (quick-model-quota.test.ts); what these tests are about is what the WALK does with it, so the two seams it
 * reads through are stood up at their thinnest: a fleet is spent or it is not.
 *
 * Default: nothing spent, so every existing test below asks its chain exactly as it always did. */
const fakeServices = (quickModel: readonly string[], spent: readonly string[] = []): Services =>
    unstubbed<Services>(`services`, {
        sandboxSettings: unstubbed<Services[`sandboxSettings`]>(`sandboxSettings`, {
            get: async () => ({ quickModel: [...quickModel] }) as Awaited<ReturnType<Services[`sandboxSettings`][`get`]>>,
        }),
        capabilities: unstubbed<Services[`capabilities`]>(`capabilities`, { list: async () => [] }),
        cliProxy: unstubbed<Services[`cliProxy`]>(`cliProxy`, {
            turnLimit: async (provider) => (spent.includes(provider) ? { spent: 1, withHeadroom: 0 } : { spent: 0, withHeadroom: 1 }),
        }),
        claudeStore: unstubbed<Services[`claudeStore`]>(`claudeStore`, {
            list: async () => [{ id: `claude-one` }] as Awaited<ReturnType<Services[`claudeStore`][`list`]>>,
        }),
        accountUsage: unstubbed<Services[`accountUsage`]>(`accountUsage`, {
            read: async () => ({
                "claude-one": { windows: [{ kind: `seven_day`, utilization: spent.includes(`claude`) ? 100 : 4 }], measuredAt: 0 },
            }),
        }),
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

// What the walk billed, in the order it spent it: one entry per model actually asked. Typed off the tracker's
// own signature rather than a lookalike, so a record the walk makes and this cannot hold is a type error here.
type Billed = { op: string; ms: number; fields: PerfFields; failed?: boolean | undefined };
const timed: Billed[] = [];

/* The refusal memo is module state that outlives a call ON PURPOSE: that is the whole feature, so the clock
 * is what separates the tests rather than a reset hatch the daemon would never have. Each one starts a full
 * memo-length past the last, by which time anything the previous test left has expired. Measured off the memo
 * itself rather than a number written twice: the window is a tuning knob, and a suite that pinned its own idea
 * of it silently stops isolating its tests the day it is raised, which is exactly what happened when it went
 * from minutes to hours. Only `Date` is faked: this path has no timers of its own, and faking those would only
 * get in the way of the promises it does have. */
const BETWEEN_TESTS_MS = REFUSED_FOR_MS + 60 * 60 * 1000;
// Comfortably past the memo, for the tests that are about it running out.
const PAST_THE_MEMO_MS = REFUSED_FOR_MS + 60 * 1000;
let clock = 1_700_000_000_000;

beforeEach(() => {
    vi.useFakeTimers({ toFake: [`Date`] });
    clock += BETWEEN_TESTS_MS;
    vi.setSystemTime(clock);
    /* RESET, not clear. `clearAllMocks` forgets the CALLS and keeps the queued one-time behaviours, so a
     * `mockRejectedValueOnce` a test set up but never reached stays armed and fires inside the NEXT test, which
     * reads as that test's own subject failing, several cases away from the one that armed it. Every mock below
     * has its behaviour restored on the next two lines, so there is nothing for a reset to lose. */
    vi.resetAllMocks();
    timed.length = 0;
    ready.mockResolvedValue({ claude: true, gemini: true, codex: true, cursor: true });
    credentials.mockResolvedValue({ ok: true });
    oneShot.mockResolvedValue(`fix: tree truncation`);
    geminiOneShot.mockResolvedValue(`fix: tree truncation`);
    cursorOneShot.mockResolvedValue(`fix: tree truncation`);
});

afterEach(() => {
    vi.useRealTimers();
});

test("spends the first model in the order and reports nothing skipped", async () => {
    const answer = await askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(answer.skipped).toEqual([]);
    expect(oneShot).toHaveBeenCalledTimes(1);
});

test("steps over a spent allowance and answers on the next model down", async () => {
    // The case the whole feature exists for: the account the chat has been running on all afternoon is out, and
    // a commit message is not worth waiting six hours for.
    oneShot.mockRejectedValueOnce(new Error(`ChatGPT usage limit reached: the allowance is exhausted.`));

    const answer = await askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), DRAFT, signal());

    expect(answer.value).toBe(`fix: tree truncation`);
    expect(answer.choice).toEqual({ provider: `claude`, model: `claude-haiku-4-5` });
    expect(answer.skipped).toEqual([{ choice: { provider: `codex`, model: `gpt-5.6` }, reason: expect.stringContaining(`usage limit`) }]);
});

test("treats a credential that fails on the way in as one more refusal to step over", async () => {
    // A token that no longer refreshes passes the cheap readiness check and dies at resolution. From the user's
    // side that is the same dead end as a spent allowance, and the next account answers both.
    credentials.mockResolvedValueOnce({ ok: false, message: `Reconnect your ChatGPT account.` });

    const answer = await askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), DRAFT, signal());

    expect(answer.choice.provider).toBe(`claude`);
    expect(answer.skipped[0]?.reason).toMatch(/ChatGPT|Reconnect/i);
});

test("names every model it asked when the whole chain is spent", async () => {
    // "Couldn't draft a commit message" on its own is indistinguishable from a broken button. What the user
    // needs is which accounts were tried and what each one said.
    oneShot.mockRejectedValue(new Error(`usage limit reached`));

    await expect(askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), DRAFT, signal())).rejects.toThrow(
        /gpt-5\.6.*claude-haiku-4-5/,
    );
});

test("stops the moment the user cancels rather than spending the rest of the chain", async () => {
    const controller = new AbortController();
    oneShot.mockImplementationOnce(async () => {
        controller.abort();
        throw new Error(`aborted`);
    });

    await expect(askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), DRAFT, controller.signal)).rejects.toThrow(`aborted`);
    expect(oneShot).toHaveBeenCalledTimes(1);
});

test("falls through Auto's own ladder when nothing is pinned", async () => {
    // Auto is an order too, so a sandbox with three accounts keeps its commit messages when the cheapest one is
    // out: without anybody having opened the settings row. Auto's head on these catalogs is the Gemini row (the
    // cheapest tier of the cheapest channel), which is why the refusal is armed on that road.
    geminiOneShot.mockRejectedValueOnce(new Error(`usage limit reached`));

    const answer = await askQuickModel(fakeServices([]), DRAFT, signal());

    expect(answer.skipped).toHaveLength(1);
    expect(answer.choice.provider).not.toBe(answer.skipped[0]?.choice.provider);
});

test("says the sandbox has no account rather than failing on a model call", async () => {
    ready.mockResolvedValue({ claude: false, gemini: false, codex: false });

    await expect(askQuickModel(fakeServices([`claude:claude-haiku-4-5`]), DRAFT, signal())).rejects.toThrow(/No AI account is connected/);
    expect(oneShot).not.toHaveBeenCalled();
});

/* NOT PAYING TWICE FOR THE SAME REFUSAL. What this is worth was measured on a real workspace: a first-pinned
 * model that answered nothing burned 58 seconds before the chain reached one that answered in 7, and it burned
 * them again on the next landing, and the one after, because the walk started from the top every time. */

test("a model that just refused is stepped over without being asked again", async () => {
    const pinned = [`codex:gpt-5.6`, `claude:claude-haiku-4-5`];
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));
    await askQuickModel(fakeServices(pinned), DRAFT, signal());
    expect(oneShot).toHaveBeenCalledTimes(2); // the refusal, then the model that answered

    oneShot.mockClear();
    const answer = await askQuickModel(fakeServices(pinned), DRAFT, signal());

    expect(oneShot).toHaveBeenCalledTimes(1);
    expect(oneShot).toHaveBeenCalledWith(expect.objectContaining({ model: `claude-haiku-4-5` }));
    // …and the account it did not spend is still accounted for, in the words that account itself last used.
    expect(answer.skipped).toEqual([{ choice: { provider: `codex`, model: `gpt-5.6` }, reason: expect.stringContaining(`usage limit`) }]);
});

test("asks it again once the memo has run out: an allowance resets and nothing announces it", async () => {
    const pinned = [`codex:gpt-5.6`, `claude:claude-haiku-4-5`];
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));
    await askQuickModel(fakeServices(pinned), DRAFT, signal());

    vi.setSystemTime(clock + PAST_THE_MEMO_MS);
    oneShot.mockClear();
    const answer = await askQuickModel(fakeServices(pinned), DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(answer.skipped).toEqual([]);
});

test("an answer clears the memo, so a recovered model keeps its place at the top", async () => {
    const pinned = [`codex:gpt-5.6`, `claude:claude-haiku-4-5`];
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));
    await askQuickModel(fakeServices(pinned), DRAFT, signal());

    // The window ends, it answers, and the walk must not go back to skipping it a moment later.
    vi.setSystemTime(clock + PAST_THE_MEMO_MS);
    await askQuickModel(fakeServices(pinned), DRAFT, signal());
    oneShot.mockClear();
    const answer = await askQuickModel(fakeServices(pinned), DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(oneShot).toHaveBeenCalledTimes(1);
});

// The memo saves time; it may never be the reason nothing gets asked at all. Every rung cooling down at once is
// exactly when a helper must still try: that is the state the chain exists for.
test("tries the whole chain anyway when every rung is cooling down", async () => {
    const pinned = [`codex:gpt-5.6`, `claude:claude-haiku-4-5`];
    oneShot.mockRejectedValue(new Error(`usage limit reached`));
    await expect(askQuickModel(fakeServices(pinned), DRAFT, signal())).rejects.toThrow();

    oneShot.mockClear();
    oneShot.mockResolvedValue(`fix: tree truncation`);
    const answer = await askQuickModel(fakeServices(pinned), DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(oneShot).toHaveBeenCalledTimes(1);
});

/* A REPLY OF THE WRONG SHAPE IS A RUNG THAT DID NOT ANSWER. This is what the ask carrying its own contract buys:
 * the guards used to run after the walk was over, so one rung answering with a tool-call stand-in (which is what
 * a Gemini rung on OpenCode's prompt does, see failure-sentences.ts) meant the helper produced nothing at all,
 * however many working accounts sat below it. Now the question moves down the chain. */

test("steps over a rung that writes a tool call instead of an answer", async () => {
    oneShot.mockResolvedValueOnce(`[tool_call: glob for pattern '**']`);

    const answer = await askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), DRAFT, signal());

    expect(answer.value).toBe(`fix: tree truncation`);
    expect(answer.choice).toEqual({ provider: `claude`, model: `claude-haiku-4-5` });
    // Reported in the words the report will show, so the Changes panel says what the rung did rather than that
    // it "answered" over a box that never filled.
    expect(answer.skipped).toEqual([{ choice: { provider: `codex`, model: `gpt-5.6` }, reason: expect.stringContaining(`tool call`) }]);
});

/* AND IT EARNS NO MEMO, which is the one place this differs from every other refusal here. A rung that replied in
 * two seconds is reachable, credentialed and fast: the wrong shape is a sample, not a condition, and remembering
 * it for hours would steer every helper in the meantime onto a worse model. */
test("an unusable reply leaves no memo: the same rung is asked again on the next call", async () => {
    const pinned = [`codex:gpt-5.6`, `claude:claude-haiku-4-5`];
    oneShot.mockResolvedValueOnce(`[tool_call: glob for pattern '**']`);
    await askQuickModel(fakeServices(pinned), DRAFT, signal());

    oneShot.mockClear();
    const answer = await askQuickModel(fakeServices(pinned), DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(oneShot).toHaveBeenCalledTimes(1);
    expect(answer.skipped).toEqual([]);
});

// Every rung answering unusably is a spent chain, and it names what each one did: "couldn't draft a message" over
// four models that all replied is the report that sends someone looking for a broken button.
test("names what every rung wrote when none of them wrote an answer", async () => {
    oneShot.mockResolvedValue(`I need more context. What am I naming?`);
    geminiOneShot.mockResolvedValue(`I need more context. What am I naming?`);

    await expect(askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), DRAFT, signal())).rejects.toThrow(
        /gpt-5\.6: answered the asker.*claude-haiku-4-5: answered the asker/,
    );
});

/* GOOGLE NEVER SEES THE CLAUDE CODE HARNESS. That CLI writes an Anthropic identity line into every request, and
 * Google's Antigravity channel refuses on that exact sentence while calling it a spent quota, so a Gemini rung
 * taking that road is a rung that cannot answer, on any of the accounts, ever. The chat already runs Gemini on
 * its own runtime for this reason; these two tests are what stop the helper drifting back. */

test("runs a Cursor rung on its own runtime, never through the Claude Code harness", async () => {
    const answer = await askQuickModel(fakeServices([`cursor:composer-2.5`]), DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `cursor`, model: `composer-2.5` });
    expect(cursorOneShot).toHaveBeenCalledWith(expect.objectContaining({ model: `composer-2.5` }));
    expect(oneShot).not.toHaveBeenCalled();
});

test("runs a Gemini rung on its own runtime, never through the Claude Code harness", async () => {
    const answer = await askQuickModel(fakeServices([`gemini:gemini-3-flash-lite`]), DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `gemini`, model: `gemini-3-flash-lite` });
    expect(geminiOneShot).toHaveBeenCalledWith(expect.objectContaining({ model: `gemini-3-flash-lite` }));
    expect(oneShot).not.toHaveBeenCalled();
});

test("keeps every other provider on the Claude Code harness", async () => {
    // The fix is scoped to the provider that refuses that loop. Sending the rest down Gemini's or Cursor's
    // road would swap one wrong runtime for another.
    await askQuickModel(fakeServices([`codex:gpt-5.6`]), DRAFT, signal());

    expect(oneShot).toHaveBeenCalledWith(expect.objectContaining({ model: `gpt-5.6` }));
    expect(geminiOneShot).not.toHaveBeenCalled();
    expect(cursorOneShot).not.toHaveBeenCalled();
});

/* NOT DISCOVERING WHAT IS ALREADY WRITTEN DOWN. The memo above only learns by being refused: one wasted call
 * per rung, re-bought every time it expires. For most providers the answer is on file before anything is spent:
 * every account's headroom and the provider's own renewal instant. Measured the day this landed: a plan reading
 * 100% with a renewal three days out was still asked three times in a single landing. */

test("steps over a rung the recorded quota already says is spent", async () => {
    const answer = await askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`], [`codex`]), DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `claude`, model: `claude-haiku-4-5` });
    expect(oneShot).toHaveBeenCalledTimes(1);
    expect(oneShot).not.toHaveBeenCalledWith(expect.objectContaining({ model: `gpt-5.6` }));
    // Reported rather than silently dropped, and in terms of the allowance rather than of a reading.
    expect(answer.skipped).toEqual([{ choice: { provider: `codex`, model: `gpt-5.6` }, reason: expect.stringContaining(`out of allowance`) }]);
});

test("a rung with headroom on file is asked, whatever the rest of the fleet looks like", async () => {
    const answer = await askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(answer.skipped).toEqual([]);
});

/* The same rule the memo answers to, for the same reason: a shortcut may never be why nothing is asked at all.
 * A snapshot can sit minutes behind a window that has already reopened, and a helper that went quiet on one
 * would be a worse failure than the wasted call it was avoiding. */
test("asks every rung anyway when the quota says the whole chain is spent", async () => {
    const answer = await askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`], [`codex`, `claude`]), DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(oneShot).toHaveBeenCalledTimes(1);
    // The second pass RETRACTS the first's skips rather than adding to them: one walk, one entry per rung.
    expect(answer.skipped).toEqual([]);
});

// A user who stopped the loop stopped this call; the model did nothing wrong and must not be skipped next time.
test("a cancel leaves no memo behind", async () => {
    const controller = new AbortController();
    oneShot.mockImplementationOnce(async () => {
        controller.abort();
        throw new Error(`aborted`);
    });
    await expect(askQuickModel(fakeServices([`codex:gpt-5.6`]), DRAFT, controller.signal)).rejects.toThrow(`aborted`);

    oneShot.mockClear();
    const answer = await askQuickModel(fakeServices([`codex:gpt-5.6`]), DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `codex`, model: `gpt-5.6` });
    expect(oneShot).toHaveBeenCalledTimes(1);
});

// `skipped` is what stood between the caller and the answer, so a cooling rung the walk never got as far as is
// not one of them: reporting it would tell the user an account was passed over when it was simply not needed.
test("does not report a cooling rung that sits behind the model that answered", async () => {
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));
    await askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), DRAFT, signal());

    const answer = await askQuickModel(fakeServices([`claude:claude-haiku-4-5`, `codex:gpt-5.6`]), DRAFT, signal());

    expect(answer.choice).toEqual({ provider: `claude`, model: `claude-haiku-4-5` });
    expect(answer.skipped).toEqual([]);
});

/* THE LIVE VIEW OF THE WALK: every beat re-told whole, which is what the Changes panel's draft report renders.
 * The order pinned here IS the user-visible timeline: asked, refused with the reason, asked the next, answered. */
test("tells a listener every beat: asking, the refusal in its own words, and the answer", async () => {
    const beats: string[] = [];
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));

    await askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), DRAFT, signal(), (attempts) =>
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
    await askQuickModel(fakeServices(pinned), DRAFT, signal());

    const beats: { model: string; status: string; reason?: string | undefined }[] = [];
    oneShot.mockClear();
    const answer = await askQuickModel(fakeServices(pinned), DRAFT, signal(), (attempts) => {
        beats.push(...attempts.slice(beats.length > 0 ? -1 : 0).map((a) => ({ model: a.choice.model, status: a.status, reason: a.reason })));
        throw new Error(`a broken listener`);
    });

    expect(answer.value).toBe(`fix: tree truncation`);
    expect(beats[0]).toEqual({ model: `gpt-5.6`, status: `skipped`, reason: `usage limit reached` });
});

/* WHICH MODEL TOOK THE TIME: the question the caller's own timing cannot answer, and the one that had to be
 * answered by watching CLI processes by hand. */
test("bills every model it asks, by name, answered or refused", async () => {
    oneShot.mockRejectedValueOnce(new Error(`usage limit reached`));

    await askQuickModel(fakeServices([`codex:gpt-5.6`, `claude:claude-haiku-4-5`]), DRAFT, signal());

    expect(timed.map((entry) => [entry.op, entry.fields[`model`], entry.failed])).toEqual([
        [`quick.model`, `gpt-5.6`, true],
        [`quick.model`, `claude-haiku-4-5`, undefined],
    ]);
});
