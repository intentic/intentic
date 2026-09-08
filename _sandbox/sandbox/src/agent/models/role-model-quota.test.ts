import { unstubbed } from "@intentic/testing";
import type { UsageWindow } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Services } from "../../composition.js";
import type { TurnLimit } from "../../usage/fleet-limit.js";
import { spentRung } from "./role-model-quota.js";

// Quota reads must only ever say spent on evidence, never as a guess; the undefined-returning cases are what this suite
// pins.

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
    const spent = await spentRung(routed({ pool: `Gemini models`, spent: 31, withHeadroom: 0, reopensAt: SECONDS + 3 * 86_400 }), GEMINI, NOW);

    expect(spent?.reason).toContain(`31`);
    expect(spent?.reason).toContain(`Gemini models`);
    expect(spent?.reason).toMatch(/3 days/);
    expect(spent?.reopensAt).toBe(SECONDS + 3 * 86_400);
});

test("asks a routed rung while any one account still has room", async () => {
    await expect(spentRung(routed({ spent: 30, withHeadroom: 1 }), GEMINI, NOW)).resolves.toBeUndefined();
});

test("asks a routed rung that nothing has measured", async () => {
    // spent:0, withHeadroom:0 means the pool was never measured, not exhausted.
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
    gates: `all`,
    ...(resetsAt === undefined ? {} : { resetsAt }),
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

test("asks Claude when an account has no reading at all", async () => {
    await expect(spentRung(claude({ one: [weekly(100)], two: undefined }), HAIKU, NOW)).resolves.toBeUndefined();
});

test("says nothing about a rung on a user's own endpoint", async () => {
    await expect(spentRung(unstubbed<Services>(`services`, {}), { provider: `endpoint/local`, model: `qwen` }, NOW)).resolves.toBeUndefined();
});
