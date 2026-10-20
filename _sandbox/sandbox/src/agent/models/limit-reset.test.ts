import type { ProviderRefusal, TranslatorAccounts, UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { unstubbed } from "@intentic/testing";
import { pino } from "pino";
import type { Services } from "../../composition.js";
import { limitReopensAt, standingReopensAt } from "./limit-reset.js";

// Pins that the refusal frame's reopen time reads the same whichever runtime ran the turn, and the two cases where
// answering nothing is the honest answer. A routed provider's fallback is the one fleet verdict every gate reads
// (serviceability.ts fleetCapacityOf), over the translator's credentials and the refusals on file.

const SECONDS = Math.floor(Date.now() / 1000);

const full = (resetsAt: number): UsageWindow => ({ kind: `seven_day`, utilization: 100, resetsAt, gates: `all` });
const room = (utilization: number): UsageWindow => ({ kind: `seven_day`, utilization, resetsAt: SECONDS + 400_000, gates: `all` });

const services = (params: {
    readonly usage?: Record<string, UsageWindow[]>;
    readonly routed?: Partial<TranslatorAccounts> | (() => Promise<TranslatorAccounts>);
    readonly refusals?: Record<string, readonly ProviderRefusal[]>;
}): Services =>
    unstubbed<Services>(`services`, {
        accountUsage: unstubbed<Services[`accountUsage`]>(`accountUsage`, {
            read: async () => Object.fromEntries(Object.entries(params.usage ?? {}).map(([id, windows]) => [id, { windows, measuredAt: 0 }])),
        }),
        cliProxy: unstubbed<Services[`cliProxy`]>(`cliProxy`, {
            accounts: async () =>
                typeof params.routed === `function` ? params.routed() : { codex: [], grok: [], kimi: [], gemini: [], ...params.routed },
        }),
        providerRefusals: unstubbed<Services[`providerRefusals`]>(`providerRefusals`, { onFile: async () => params.refusals ?? {} }),
        providerAccounts: async () => [],
        logger: pino({ level: `silent` }),
    });

// A routed credential the translator holds, read as given.
const credential = (name: string, ...windows: UsageWindow[]) => ({ name, label: name, usage: { measuredAt: Date.now(), windows } });

test("a native Codex turn gets the fleet's reset, which its own account key could never answer for", async () => {
    // The account key names the shared subscription, not a connected account; the per-account fallback never finds it.
    const at = await limitReopensAt({
        services: services({ routed: { codex: [credential(`a`, full(SECONDS + 7_200)), credential(`b`, full(SECONDS + 9_000))] } }),
        provider: `codex`,
        model: `gpt-5.1`,
        account: `codex-subscription`,
    });

    // Any one credential reopening unblocks the turn.
    expect(at).toBe(SECONDS + 7_200);
});

test("a routed turn under the Claude Code harness, which names no account at all, resolves the same way", async () => {
    const at = await limitReopensAt({
        services: services({ routed: { gemini: [credential(`g`, full(SECONDS + 86_400))] } }),
        provider: `gemini`,
        model: `gemini-3-pro`,
        account: undefined,
    });

    expect(at).toBe(SECONDS + 86_400);
});

test("a routed fleet refused for the model reopens when the provider said, the instant every gate reads", async () => {
    const at = await limitReopensAt({
        services: services({
            routed: { codex: [credential(`a`, room(20))] },
            refusals: { codex: [{ at: Date.now() - 60_000, kind: `limit`, message: `try again at 3:38 PM`, model: `gpt-5.1`, resetsAt: SECONDS + 3_000 }] },
        }),
        provider: `codex`,
        model: `gpt-5.1`,
        account: `codex-subscription`,
    });

    expect(at).toBe(SECONDS + 3_000);
});

test("a native Claude turn keeps reading its own account's snapshot", async () => {
    // Pinned so unifying the others can't reroute this already-working path: Claude's windows are filed per account.
    const at = await limitReopensAt({
        services: services({ usage: { "acct-1": [full(SECONDS + 3_600)] } }),
        provider: `claude`,
        model: `opus`,
        account: `acct-1`,
    });

    expect(at).toBe(SECONDS + 3_600);
});

test("the account's own snapshot wins over the fleet when both can answer", async () => {
    const at = await limitReopensAt({
        services: services({ usage: { "acct-1": [full(SECONDS + 600)] }, routed: { codex: [credential(`a`, full(SECONDS + 99_999))] } }),
        provider: `codex`,
        model: `gpt-5.1`,
        account: `acct-1`,
    });

    expect(at).toBe(SECONDS + 600);
});

test("says nothing for a provider that publishes no readable quota", async () => {
    // Grok is absent from PLAN_LIMIT_PROVIDERS, so its credentials carry no reading; the client keeps its retry ladder.
    await expect(
        limitReopensAt({ services: services({ routed: { grok: [{ name: `x`, label: `x` }] } }), provider: `grok`, model: `grok-4`, account: `xai` }),
    ).resolves.toBeUndefined();
});

test("says nothing for a runtime the translator does not serve", async () => {
    // Cursor runs on Anysphere's own SDK against its own account, so neither reading covers it.
    await expect(limitReopensAt({ services: services({}), provider: `cursor`, model: `auto`, account: `cursor-acct` })).resolves.toBeUndefined();
});

test("withholds the reset while any account can still serve", async () => {
    // Room on file means quota didn't refuse the turn on every account, so a weekly reset would mislead.
    await expect(
        limitReopensAt({
            services: services({ routed: { codex: [credential(`a`, full(SECONDS + 7_200)), credential(`b`, room(30))] } }),
            provider: `codex`,
            model: `gpt-5.1`,
            account: `codex-subscription`,
        }),
    ).resolves.toBeUndefined();
});

test("a lookup that fails takes nothing with it", async () => {
    // Losing the refusal's own message to a broken lookup would be worse than losing the countdown.
    await expect(
        limitReopensAt({
            services: services({ routed: () => Promise.reject(new Error(`management API unreachable`)) }),
            provider: `codex`,
            model: `gpt-5.1`,
            account: `codex-subscription`,
        }),
    ).resolves.toBeUndefined();
});

// 2026-10-17: Kimi said "You've reached your 5-hour usage limit", the translator benched the credential for thirty
// minutes, and the reading knew the five-hour window had two hours left. The named pool's own reset is the answer.
test("a refusal naming its pool by length reads that pool's reset, even before the reading shows it full", async () => {
    const routed = services({
        routed: {
            kimi: [
                {
                    name: `k`,
                    label: `k`,
                    usage: {
                        measuredAt: Date.now(),
                        windows: [
                            { kind: `five_hour`, utilization: 80, resetsAt: SECONDS + 7_200, gates: `all` },
                            { kind: `seven_day`, utilization: 40, resetsAt: SECONDS + 400_000, gates: `all` },
                        ],
                    },
                    cooling: { until: SECONDS + 1_800, reason: `429` },
                },
            ],
        },
    });

    expect(await limitReopensAt({ services: routed, provider: `kimi`, model: `kimi-k3`, account: undefined, period: 5 * 3_600 })).toBe(SECONDS + 7_200);
    // With no pool named, the fleet's own word: the credential is benched until the translator asks again.
    expect(await limitReopensAt({ services: routed, provider: `kimi`, model: `kimi-k3`, account: undefined })).toBe(SECONDS + 1_800);
});

describe("the sandbox's standing word on a pool", () => {
    const NOW = SECONDS * 1000;
    const standing = (refusals: readonly ProviderRefusal[]) =>
        unstubbed<Pick<Services, `providerRefusals`>>(`standing`, {
            providerRefusals: unstubbed<Services[`providerRefusals`]>(`providerRefusals`, { onFile: async () => ({ codex: refusals, claude: refusals }) }),
        });
    const spent = (over: Partial<ProviderRefusal>): ProviderRefusal => ({ at: NOW - 60_000, kind: `limit`, message: `try again at 1:53 PM`, ...over });

    // A Codex 429 handed over with no instant, two minutes after a sibling on the same model was told when it reopens.
    test("times a routed refusal by the last one on file for its model, whatever label the turn rode under", async () => {
        const records = standing([spent({ model: `gpt-6.1-sol`, resetsAt: SECONDS + 8_000 })]);
        await expect(
            standingReopensAt({ services: records, provider: `codex`, model: `gpt-6.1-sol`, account: `codex-subscription`, now: NOW }),
        ).resolves.toBe(SECONDS + 8_000);
    });

    test("reads every refusal on file for the model, and the latest of them still ahead", async () => {
        const records = standing([spent({ model: `gpt-6.1-sol`, resetsAt: SECONDS + 8_000 }), spent({ at: NOW - 30_000, resetsAt: SECONDS + 9_000 })]);
        await expect(standingReopensAt({ services: records, provider: `codex`, model: `gpt-6.1-sol`, account: undefined, now: NOW })).resolves.toBe(
            SECONDS + 9_000,
        );
    });

    test("says nothing for another model's pool, another account's, a past instant, or a refusal that named none", async () => {
        const records = standing([
            spent({ model: `gpt-6-astra`, resetsAt: SECONDS + 8_000 }),
            spent({ model: `opus`, account: `other`, resetsAt: SECONDS + 8_000 }),
            spent({ model: `opus`, resetsAt: SECONDS - 10 }),
            spent({ model: `opus` }),
            spent({ kind: `auth`, resetsAt: SECONDS + 8_000 }),
        ]);
        await expect(standingReopensAt({ services: records, provider: `codex`, model: `gpt-6.1-sol`, account: undefined, now: NOW })).resolves.toBeUndefined();
        await expect(standingReopensAt({ services: records, provider: `claude`, model: `opus`, account: `acct`, now: NOW })).resolves.toBeUndefined();
    });
});
