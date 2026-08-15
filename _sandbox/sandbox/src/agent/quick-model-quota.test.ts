import { unstubbed } from "@intentic/testing";
import type { UsageWindow } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import type { TurnLimit } from "../usage/translator-usage.js";
import { spentRung } from "./quick-model-quota.js";

/* READING THE QUOTA INSTEAD OF DISCOVERING IT. Every case here is about the same trade: this may only ever say
 * "spent", and only on evidence, because a wrong "spent" retires a working account silently while a wrong
 * "ask it" costs one call. So the tests that matter most are the ones asserting `undefined`. */

const NOW = 1_700_000_000_000;
const SECONDS = Math.floor(NOW / 1000);

const routed = (limit: TurnLimit): Services =>
    unstubbed<Services>(`services`, {
        cliProxy: unstubbed<Services[`cliProxy`]>(`cliProxy`, { turnLimit: async () => limit }),
    });

const claude = (accounts: Record<string, UsageWindow[] | undefined>): Services =>
    unstubbed<Services>(`services`, {
        claudeStore: unstubbed<Services[`claudeStore`]>(`claudeStore`, {
            list: async () => Object.keys(accounts).map((id) => ({ id }) as Awaited<ReturnType<Services[`claudeStore`][`list`]>>[number]),
        }),
        accountUsage: unstubbed<Services[`accountUsage`]>(`accountUsage`, {
            read: async () =>
                Object.fromEntries(
                    Object.entries(accounts).flatMap(([id, windows]) => (windows === undefined ? [] : [[id, { windows, measuredAt: NOW }]])),
                ),
        }),
    });

const GEMINI = { provider: `gemini`, model: `gemini-3-flash-lite` };
const HAIKU = { provider: `claude`, model: `claude-haiku-4-5` };

test("steps over a routed fleet whose every account is spent, and says when it comes back", async () => {
    // The measured case this exists for: a plan at 100% with a renewal three days out, asked three times in one
    // landing because nothing consulted the number that was already on file.
    const spent = await spentRung(routed({ pool: `Gemini models`, spent: 31, withHeadroom: 0, reopensAt: SECONDS + 3 * 86_400 }), GEMINI, NOW);

    expect(spent?.reason).toBe(`All 31 connected accounts are out of Gemini models allowance — renews in about 3 days.`);
    expect(spent?.reopensAt).toBe(SECONDS + 3 * 86_400);
});

test("asks a routed rung while any one account still has room", async () => {
    // Everything cooling with headroom on file is not a quota problem, so the allowance may not be what steps
    // over it — that is the refusal's job, and it lasts minutes rather than until a weekly reset.
    await expect(spentRung(routed({ spent: 30, withHeadroom: 1 }), GEMINI, NOW)).resolves.toBeUndefined();
});

test("asks a routed rung that nothing has measured", async () => {
    // Both counts zero ⇒ no reading covers this pool (never polled, or a bucket the vendor renamed). Claiming
    // the fleet is spent from that would take a whole provider out of the chain on no evidence at all.
    await expect(spentRung(routed({ spent: 0, withHeadroom: 0 }), GEMINI, NOW)).resolves.toBeUndefined();
});

test("asks the rung when the reading itself cannot be taken", async () => {
    const broken = unstubbed<Services>(`services`, {
        cliProxy: unstubbed<Services[`cliProxy`]>(`cliProxy`, {
            turnLimit: async () => {
                throw new Error(`management API unreachable`);
            },
        }),
    });

    await expect(spentRung(broken, GEMINI, NOW)).resolves.toBeUndefined();
});

const weekly = (utilization: number, resetsAt?: number): UsageWindow => ({
    kind: `seven_day`,
    utilization,
    ...(resetsAt === undefined ? {} : { resetsAt }),
});

test("steps over Claude only when every connected account is at its cap", async () => {
    const spent = await spentRung(claude({ one: [weekly(100, SECONDS + 7_200)], two: [weekly(100, SECONDS + 3_600)] }), HAIKU, NOW);

    // The EARLIEST reset, because either account reopening is enough to unblock the rung.
    expect(spent?.reason).toBe(`All 2 connected Claude accounts are out of allowance — renews in about 1h.`);
    expect(spent?.reopensAt).toBe(SECONDS + 3_600);
});

test("asks Claude while one account of several still has room", async () => {
    await expect(spentRung(claude({ one: [weekly(100)], two: [weekly(89)] }), HAIKU, NOW)).resolves.toBeUndefined();
});

test("a per-model pool at its cap does not retire the whole Claude rung", async () => {
    /* The subtlety that decides whether this feature is safe. A plan's per-model allowance ("Fable", "Opus")
     * arrives under the provider's own display name, and nothing connects that name to the model id this helper
     * is about to run — so a spent Fable pool says nothing about a cheap Haiku call. Reading it as one allowance
     * would take the most reliable rung in the chain out of service on a limit it does not spend. */
    const account = { one: [weekly(12), { kind: `model:Fable`, label: `Fable`, utilization: 100 }] };

    await expect(spentRung(claude(account), HAIKU, NOW)).resolves.toBeUndefined();
});

test("asks Claude when an account has no reading at all", async () => {
    // A fresh sandbox has measured nothing. Unmeasured is not spent, or the feature would disable itself before
    // it had ever run a turn.
    await expect(spentRung(claude({ one: [weekly(100)], two: undefined }), HAIKU, NOW)).resolves.toBeUndefined();
});

test("says nothing about a rung on a user's own endpoint", async () => {
    // An endpoint publishes no quota, so there is nothing to read and the refusal memo is the only cover.
    await expect(spentRung(unstubbed<Services>(`services`, {}), { provider: `endpoint/local`, model: `qwen` }, NOW)).resolves.toBeUndefined();
});
