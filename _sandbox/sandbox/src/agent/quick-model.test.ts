import { unstubbed } from "@intentic/testing";
import { beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../composition.js";

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
    });

const signal = (): AbortSignal => new AbortController().signal;

beforeEach(() => {
    vi.clearAllMocks();
    ready.mockResolvedValue({ claude: true, gemini: true, codex: true });
    credentials.mockResolvedValue({ ok: true });
    oneShot.mockResolvedValue(`fix: tree truncation`);
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
