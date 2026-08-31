import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config.js";
import { hostedFleet, renderHostedFleet, type HostedFleetRole } from "./hosted-fleet.js";

/* WHAT THE FLY CONSOLE CANNOT SAY. The fleet view exists for exactly one confusion: a warm machine's app is
 * named `<prefix>-pool-<hex>` before anybody claims it, and Fly never lets a name change, so after a claim
 * that app is a person's sandbox still called `pool`. These pin the classification that fixes it, including
 * the two disagreements between Fly and the platform (an app with no row, a row with no app) that are the
 * only reasons an operator would go looking. */

const config = (): Config =>
    ({
        ingress: { url: `https://ingress.sbx.test`, signingKey: `k`, zone: `sbx.test` },
        hosted: { flyApiToken: `fly`, flyOrg: `intentic`, appPrefix: `intentic-sbx` },
    }) as unknown as Config;

const fakePrisma = (machines: unknown[], pooled: unknown[]) =>
    ({
        hostedMachine: { findMany: vi.fn().mockResolvedValue(machines) },
        hostedPoolMachine: { findMany: vi.fn().mockResolvedValue(pooled) },
    }) as never;

const taken = (over?: Record<string, unknown>) => ({
    appName: `intentic-sbx-pool-claimed1`,
    sandboxId: `s1`,
    region: `iad`,
    wokeAt: new Date(),
    sandbox: { owner: { email: `owner@example.com` } },
    ...over,
});

const stubApps = (names: string[]) =>
    vi.stubGlobal(`fetch`, () => Promise.resolve(new Response(JSON.stringify({ apps: names.map((name) => ({ name })) }), { status: 200 })));

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`hostedFleet`, () => {
    it(`names a claimed pool app for what it is: the console only ever sees the word "pool"`, async () => {
        stubApps([`intentic-sbx-pool-claimed1`, `intentic-sbx-pool-warm1`]);
        const fleet = await hostedFleet(fakePrisma([taken()], [{ appName: `intentic-sbx-pool-warm1`, region: `arn`, state: `ready` }]), config());
        expect(fleet).toEqual([
            {
                appName: `intentic-sbx-pool-claimed1`,
                role: `taken`,
                region: `iad`,
                owner: `owner@example.com`,
                sandboxId: `s1`,
                awake: true,
                missing: false,
            },
            { appName: `intentic-sbx-pool-warm1`, role: `warm`, region: `arn`, missing: false },
        ]);
    });

    it(`separates a hand-off in flight from standing stock: a claiming row is nobody's to destroy`, async () => {
        stubApps([`intentic-sbx-pool-mid`]);
        const fleet = await hostedFleet(fakePrisma([], [{ appName: `intentic-sbx-pool-mid`, region: `iad`, state: `claimed` }]), config());
        expect(fleet[0]?.role).toBe(`claiming`);
    });

    it(`surfaces both disagreements: an app with no row, and a row whose app is gone`, async () => {
        // `intentic-sbx-stray` exists on Fly with nothing behind it (reaper food); the taken row's app does not
        // exist at all. Apps outside the prefix are not ours and must never appear.
        stubApps([`intentic-sbx-stray`, `someone-elses-app`]);
        const fleet = await hostedFleet(fakePrisma([taken()], []), config());
        expect(fleet.map((entry) => [entry.appName, entry.role, entry.missing])).toEqual([
            [`intentic-sbx-pool-claimed1`, `taken`, true],
            [`intentic-sbx-stray`, `orphan`, false],
        ]);
    });
});

describe(`renderHostedFleet`, () => {
    it(`puts people's machines first and ends with the tally an operator actually reads`, () => {
        const entries = [
            {
                appName: `intentic-sbx-pool-a`,
                role: `taken` as const,
                region: `iad`,
                owner: `owner@example.com`,
                sandboxId: `s1`,
                awake: false,
                missing: false,
            },
            { appName: `intentic-sbx-pool-b`, role: `warm` as const, region: `arn`, missing: false },
        ];
        const text = renderHostedFleet(entries);
        const lines = text.split(`\n`);
        const tally = (role: HostedFleetRole) => entries.filter((entry) => entry.role === role).length;
        expect(lines[0]).toMatch(/^ROLE\s+REGION\s+APP\s+OWNER\s+POWER$/);
        expect(lines[1]).toContain(`owner@example.com`);
        expect(lines[1]).toContain(`asleep`);
        expect(lines.at(-1)).toBe(`${tally(`taken`)} taken · ${tally(`warm`)} warm · ${tally(`claiming`)} claiming · ${tally(`orphan`)} orphaned`);
    });
});
