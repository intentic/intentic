import { unstubbed } from "@intentic/testing";
import type { ProviderRefusal, UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { Services } from "../../composition.js";
import { PROVIDER_MODULES } from "../../runtimes/runtime-table.js";
import { opt } from "../../opt.js";
import { spentRung } from "./role-model-quota.js";

// Quota reads must only ever say spent on evidence, never as a guess; the undefined-returning cases are what this suite
// pins.

const NOW = 1_700_000_000_000;
const SECONDS = Math.floor(NOW / 1000);

// Every provider's own module, as composition hands them in: only one keeping its own reading answers for itself. A
// routed provider's accounts are the translator's rows, judged with the refusals on file as the listing judges them.
const routed = (accounts: Record<string, UsageWindow[] | undefined>, refusals: readonly ProviderRefusal[] = []): Services =>
    unstubbed<Services>(`services`, {
        providerModules: PROVIDER_MODULES,
        cliProxy: unstubbed<Services[`cliProxy`]>(`cliProxy`, {
            accounts: async () => ({
                codex: [],
                grok: [],
                kimi: [],
                gemini: Object.entries(accounts).map(([name, windows]) => ({ name, label: name, ...(windows === undefined ? {} : { usage: { windows, measuredAt: NOW } }) })),
            }),
        }),
        providerRefusals: unstubbed<Services[`providerRefusals`]>(`providerRefusals`, { onFile: async () => ({ gemini: refusals }) }),
    });

const claude = (accounts: Record<string, UsageWindow[] | undefined>, seats: Record<string, string> = {}): Services =>
    unstubbed<Services>(`services`, {
        claudeStore: unstubbed<Services[`claudeStore`]>(`claudeStore`, {
            list: async () => Object.keys(accounts).map((id) => ({ id }) as Awaited<ReturnType<Services[`claudeStore`][`list`]>>[number]),
        }),
        claudeSeats: unstubbed<Services[`claudeSeats`]>(`claudeSeats`, {
            read: async () => Object.fromEntries(Object.entries(seats).map(([id, reason]) => [id, { reason, at: NOW }])),
        }),
        accountUsage: unstubbed<Services[`accountUsage`]>(`accountUsage`, {
            read: async () =>
                Object.fromEntries(
                    Object.entries(accounts).flatMap(([id, windows]) => (windows === undefined ? [] : [[id, { windows, measuredAt: NOW }]])),
                ),
        }),
        providerRefusals: unstubbed<Services[`providerRefusals`]>(`providerRefusals`, { onFile: async () => ({}) }),
    });

const GEMINI = { provider: `gemini`, model: `gemini-3-flash-lite` };
const HAIKU = { provider: `claude`, model: `claude-haiku-4-5` };

// A pool the plan meters for Gemini's models alone, as the translator reads it.
const gemini = (utilization: number, resetsAt?: number): UsageWindow => ({
    kind: `google:gemini-weekly`,
    label: `Gemini models`,
    utilization,
    gates: { models: [`gemini`] },
    ...opt(`resetsAt`, resetsAt),
});

test("steps over a routed fleet whose every account is spent, and says when it comes back", async () => {
    const spent = await spentRung(routed({ a: [gemini(100, SECONDS + 3 * 86_400)], b: [gemini(100, SECONDS + 4 * 86_400)] }), GEMINI, NOW);

    expect(spent?.reason).toContain(`All 2 connected accounts`);
    expect(spent?.reason).toContain(`Gemini models`);
    expect(spent?.reason).toMatch(/3 days/);
    expect(spent?.reopensAt).toBe(SECONDS + 3 * 86_400);
});

test("asks a routed rung while any one account still has room", async () => {
    await expect(spentRung(routed({ a: [gemini(100, SECONDS + 3_600)], b: [gemini(40)] }), GEMINI, NOW)).resolves.toBeUndefined();
});

test("asks a routed rung that nothing has measured", async () => {
    await expect(spentRung(routed({ a: undefined }), GEMINI, NOW)).resolves.toBeUndefined();
});

// The listing believes a plan that just said no over a usage endpoint still showing room; the gate must believe it too,
// or a spawn the listing calls spent goes through, and a restart re-run lands on the refusal.
test("steps over a routed rung a standing refusal holds, whatever the reading still shows", async () => {
    // On the real clock: a refusal stands until the instant it named, judged against now.
    const reopens = Math.floor(Date.now() / 1000) + 3_600;
    const refusal: ProviderRefusal = { at: Date.now() - 60_000, kind: `limit`, message: `You've hit your usage limit.`, resetsAt: reopens };
    const spent = await spentRung(routed({ a: [gemini(10)] }, [refusal]), GEMINI);

    expect(spent?.reopensAt).toBe(reopens);
});

test("asks the rung when the reading itself cannot be taken", async () => {
    const broken = unstubbed<Services>(`services`, {
        providerModules: PROVIDER_MODULES,
        cliProxy: unstubbed<Services[`cliProxy`]>(`cliProxy`, {
            accounts: async () => {
                throw new Error(`management API unreachable`);
            },
        }),
        providerRefusals: unstubbed<Services[`providerRefusals`]>(`providerRefusals`, { onFile: async () => ({}) }),
    });

    await expect(spentRung(broken, GEMINI, NOW)).resolves.toBeUndefined();
});

const weekly = (utilization: number, resetsAt?: number): UsageWindow => ({
    kind: `seven_day`,
    utilization,
    gates: `all`,
    ...opt(`resetsAt`, resetsAt),
});

test("steps over Claude only when every connected account is at its cap", async () => {
    const spent = await spentRung(claude({ one: [weekly(100, SECONDS + 7_200)], two: [weekly(100, SECONDS + 3_600)] }), HAIKU, NOW);

    expect(spent?.reason).toContain(`2`);
    expect(spent?.reason).toContain(`Claude`);
    expect(spent?.reason).toMatch(/1h/);
    expect(spent?.reopensAt).toBe(SECONDS + 3_600);
});

test("asks Claude while one account of several still has room", async () => {
    await expect(spentRung(claude({ one: [weekly(100)], two: [weekly(89)] }), HAIKU, NOW)).resolves.toBeUndefined();
});

test("a per-model pool at its cap does not retire the whole Claude rung", async () => {
    // A per-model pool (e.g. `model:Fable`) is scoped by name to its own model id, separate from the plan-wide weekly
    // window.
    const account = { one: [weekly(12), { kind: `model:Fable`, label: `Fable`, utilization: 100, gates: { models: [`Fable`] } }] };

    await expect(spentRung(claude(account), HAIKU, NOW)).resolves.toBeUndefined();
    const fable = await spentRung(claude(account), { provider: `claude`, model: `claude-fable-5` }, NOW);
    expect(fable?.reason).toContain(`Fable allowance`);
});

// The account rows call a seatless account unable to serve; the gate once read only its usage and saw room on it.
test("steps over Claude when the only account with room has lost its seat", async () => {
    const spent = await spentRung(claude({ one: [weekly(100, SECONDS + 3_600)], two: [weekly(10)] }, { two: `Claude Code is not enabled for your seat.` }), HAIKU, NOW);

    expect(spent?.reason).toContain(`All 2 connected Claude accounts`);
});

test("asks Claude when an account has no reading at all", async () => {
    await expect(spentRung(claude({ one: [weekly(100)], two: undefined }), HAIKU, NOW)).resolves.toBeUndefined();
});

test("says nothing about a rung on a user's own endpoint", async () => {
    await expect(
        spentRung(unstubbed<Services>(`services`, { providerModules: PROVIDER_MODULES }), { provider: `endpoint/local`, model: `qwen` }, NOW),
    ).resolves.toBeUndefined();
});

// Cursor publishes no allowance, so its rung is read off what it has already refused, per account and per model.
const cursor = (accounts: Record<string, readonly string[]>): Services =>
    unstubbed<Services>(`services`, {
        providerModules: PROVIDER_MODULES,
        cursorStore: unstubbed<Services[`cursorStore`]>(`cursorStore`, {
            credentials: async () => Object.keys(accounts).map((id) => ({ id, apiKey: `k`, connectedAt: 0 })),
        }),
        cursorModels: unstubbed<Services[`cursorModels`]>(`cursorModels`, {
            models: async () => ({ models: [{ id: `composer-2.5`, label: `Composer 2.5` }], default: `composer-2.5` }),
        }),
        observedLimits: unstubbed<Services[`observedLimits`]>(`observedLimits`, {
            spent: async (_provider, account) =>
                Object.fromEntries((accounts[account] ?? []).map((model) => [model, { at: NOW, message: `429 usage limit reached` }])),
        }),
    });

const COMPOSER = { provider: `cursor`, model: `composer-2.5` };

// The rung that went unused: one account is out of Composer, the other is not, and the chain must still ask it.
test("asks Cursor while one account still has the model, whatever the other is out of", async () => {
    await expect(spentRung(cursor({ one: [`composer-2.5`], two: [] }), COMPOSER, NOW)).resolves.toBeUndefined();
});

test("steps over Cursor once every account has been refused that model, naming the pool", async () => {
    const spent = await spentRung(cursor({ one: [`composer-2.5`], two: [`composer-2.5`] }), COMPOSER, NOW);

    expect(spent?.reason).toContain(`2`);
    expect(spent?.reason).toContain(`Composer 2.5 allowance`);
    // Cursor publishes no reset, so the sentence must not date one.
    expect(spent?.reopensAt).toBeUndefined();
    expect(spent?.reason).not.toMatch(/renews/);
});

test("an account out of another model is still asked for this one", async () => {
    await expect(spentRung(cursor({ one: [`claude-opus-5`] }), COMPOSER, NOW)).resolves.toBeUndefined();
});
