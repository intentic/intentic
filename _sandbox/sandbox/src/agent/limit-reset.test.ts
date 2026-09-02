import type { UsageWindow } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import type { TurnLimit } from "../usage/fleet-limit.js";
import { limitReopensAt } from "./limit-reset.js";

/* ONE ANSWER FOR EVERY RUNTIME. The case that drove this is the native one: a Codex turn refused by a spent
 * ChatGPT plan whose reset was already on file, going out with no instant on the frame, so the chat offered a
 * five-second retry into a window hours from reopening. Every test here is about the frame being dressed the
 * same whichever loop ran the turn, and about the two places it is honest to answer nothing. */

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
    /* THE BUG, in one case. A native routed turn names the subscription serving every turn of its provider
     * ("codex-subscription"), not a connected account, so nothing is ever filed under that key and the
     * per-account fallback returned undefined however fresh the quota reading was. */
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
    // The path that already worked, pinned so unifying the others cannot quietly reroute it: Claude's windows are
    // filed per connected account and the translator knows nothing about them.
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
    // Grok is deliberately absent from PLAN_LIMIT_PROVIDERS, so its pool reads empty and there is no instant to
    // schedule against. The client keeps its retry ladder, which is the honest answer rather than a leftover.
    await expect(
        limitReopensAt({ services: services({ limit: { spent: 0, withHeadroom: 0 } }), provider: `grok`, model: `grok-4`, account: `xai` }),
    ).resolves.toBeUndefined();
});

test("says nothing for a runtime the translator does not serve", async () => {
    // Cursor runs on Anysphere's own SDK against its own account, so neither reading covers it.
    await expect(limitReopensAt({ services: services({}), provider: `cursor`, model: `auto`, account: `cursor-acct` })).resolves.toBeUndefined();
});

test("withholds the reset while any account still has headroom", async () => {
    // turnLimit's own rule, relied on here rather than re-derived: with room on file the quota is not what
    // refused the turn, so naming a weekly reset would send the user away for days over a cooldown.
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
    // This dresses a frame describing a failure that already happened. Losing the refusal's own sentence to a
    // broken management call would be strictly worse than losing the countdown.
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
