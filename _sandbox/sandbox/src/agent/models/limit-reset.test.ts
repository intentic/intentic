import type { UsageWindow } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import type { Services } from "../../composition.js";
import type { TurnLimit } from "../../usage/fleet-limit.js";
import { limitReopensAt } from "./limit-reset.js";

// Pins that the refusal frame's reopen time reads the same whichever runtime ran the turn, and the two cases where
// answering nothing is the honest answer.

const SECONDS = 1_700_000_000;

const services = (params: { readonly usage?: Record<string, UsageWindow[]>; readonly limit?: TurnLimit | (() => Promise<TurnLimit>) }): Services =>
    unstubbed<Services>(`services`, {
        accountUsage: unstubbed<Services[`accountUsage`]>(`accountUsage`, {
            read: async () => Object.fromEntries(Object.entries(params.usage ?? {}).map(([id, windows]) => [id, { windows, measuredAt: 0 }])),
        }),
        cliProxy: unstubbed<Services[`cliProxy`]>(`cliProxy`, {
            turnLimit: async () => (typeof params.limit === `function` ? params.limit() : (params.limit ?? { spent: 0, withHeadroom: 0 })),
        }),
    });

test("a native Codex turn gets the translator's reset, which its own account key could never answer for", async () => {
    // The account key names the shared subscription, not a connected account; the per-account fallback never finds it.
    const at = await limitReopensAt({
        services: services({ limit: { spent: 3, withHeadroom: 0, reopensAt: SECONDS + 7_200 } }),
        provider: `codex`,
        model: `gpt-5.1`,
        account: `codex-subscription`,
    });

    expect(at).toBe(SECONDS + 7_200);
});

test("a routed turn under the Claude Code harness, which names no account at all, resolves the same way", async () => {
    const at = await limitReopensAt({
        services: services({ limit: { pool: `Gemini models`, spent: 4, withHeadroom: 0, reopensAt: SECONDS + 86_400 } }),
        provider: `gemini`,
        model: `gemini-3-pro`,
        account: undefined,
    });

    expect(at).toBe(SECONDS + 86_400);
});

test("a native Claude turn keeps reading its own account's snapshot", async () => {
    // Pinned so unifying the others can't reroute this already-working path: Claude's windows are filed per account.
    const at = await limitReopensAt({
        services: services({ usage: { "acct-1": [{ kind: `seven_day`, utilization: 100, resetsAt: SECONDS + 3_600, gates: `all` }] } }),
        provider: `claude`,
        model: `opus`,
        account: `acct-1`,
    });

    expect(at).toBe(SECONDS + 3_600);
});

test("the account's own snapshot wins over the pool when both can answer", async () => {
    const at = await limitReopensAt({
        services: services({
            usage: { "acct-1": [{ kind: `seven_day`, utilization: 100, resetsAt: SECONDS + 600, gates: `all` }] },
            limit: { spent: 1, withHeadroom: 0, reopensAt: SECONDS + 99_999 },
        }),
        provider: `codex`,
        model: `gpt-5.1`,
        account: `acct-1`,
    });

    expect(at).toBe(SECONDS + 600);
});

test("says nothing for a provider that publishes no readable quota", async () => {
    // Grok is absent from PLAN_LIMIT_PROVIDERS, so its pool reads empty; the client just keeps its retry ladder.
    await expect(
        limitReopensAt({ services: services({ limit: { spent: 0, withHeadroom: 0 } }), provider: `grok`, model: `grok-4`, account: `xai` }),
    ).resolves.toBeUndefined();
});

test("says nothing for a runtime the translator does not serve", async () => {
    // Cursor runs on Anysphere's own SDK against its own account, so neither reading covers it.
    await expect(limitReopensAt({ services: services({}), provider: `cursor`, model: `auto`, account: `cursor-acct` })).resolves.toBeUndefined();
});

test("withholds the reset while any account still has headroom", async () => {
    // turnLimit's rule: headroom on file means quota didn't refuse the turn, so a weekly reset would mislead.
    await expect(
        limitReopensAt({
            services: services({ limit: { spent: 30, withHeadroom: 1 } }),
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
            services: services({
                limit: () => Promise.reject(new Error(`management API unreachable`)),
            }),
            provider: `codex`,
            model: `gpt-5.1`,
            account: `codex-subscription`,
        }),
    ).resolves.toBeUndefined();
});
