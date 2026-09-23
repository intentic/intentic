import { usageContract } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { UsageRoutesDeps } from "./usage.routes.js";
import { createUsageRoutes } from "./usage.routes.js";
import { routesClient } from "../harness/route-client.testing.js";

// Usage routes tested against `UsageRoutesDeps`, a `Pick<Services, ...>`, rather than the full daemon, so services the
// daemon grows later cannot reach this file.

test("usage.rollup round-trips the ledger's rows and forwards the day bounds to the store", async () => {
    const asked: { from?: string | undefined; to?: string | undefined }[] = [];
    const client = routesClient(
        usageContract,
        createUsageRoutes(
            unstubbed<UsageRoutesDeps>("usage deps", {
                usage: unstubbed("usage", {
                    rollup: async (query) => {
                        asked.push(query);
                        return [
                            {
                                day: "2026-07-20",
                                provider: "claude",
                                account: "work",
                                model: "opus-5",
                                harness: "native",
                                turns: 2,
                                inputTokens: 200,
                                outputTokens: 100,
                                cacheReadTokens: 20,
                                cacheCreationTokens: 10,
                                costUsd: 0.5,
                                durationMs: 2_000,
                            },
                        ];
                    },
                }),
            }),
        ),
    );

    const result = await client.rollup({ from: "2026-07-01", to: "2026-07-31" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ day: "2026-07-20", model: "opus-5", costUsd: 0.5, turns: 2 });
    expect(asked).toEqual([{ from: "2026-07-01", to: "2026-07-31" }]);
});

// The eligibility probe reads the same endpoint the headroom sweep does, so it asks that service whether the provider
// is holding this account off, and arms the same park from its own refusal.
const sharedGate = (parked: Set<string> = new Set()) =>
    unstubbed<UsageRoutesDeps["headroom"]>("headroom", {
        parked: async (account) => parked.has(account),
        park: async (_provider, account) => {
            parked.add(account);
        },
        record: async () => {},
    });

test("usage.limitReset answers for an account the store has no credential for, rather than failing the strip that asked", async () => {
    const asked: string[] = [];
    const client = routesClient(
        usageContract,
        createUsageRoutes(
            unstubbed<UsageRoutesDeps>("usage deps", {
                headroom: sharedGate(),
                claudeStore: unstubbed("claudeStore", {
                    read: async (id) => {
                        asked.push(id);
                        return undefined;
                    },
                }),
            }),
        ),
    );

    expect(await client.limitReset({ account: "nobody" })).toEqual({ available: false });
    // A claim with no credential returns an actionable error instead of posting anything.
    expect(await client.claimLimitReset({ account: "nobody" })).toMatchObject({ result: "error", detail: expect.stringContaining("Reconnect") });
    expect(asked).toEqual(["nobody", "nobody"]);
});

test("a rate-limited eligibility probe fails over the wire, and the ask after it is held off rather than sent", async () => {
    const fetcher = jest
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("{}", { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ juniper_tide: { eligible: true, available: true, arm: "reset" } })));
    try {
        const client = routesClient(
            usageContract,
            createUsageRoutes(
                unstubbed<UsageRoutesDeps>("usage deps", {
                    headroom: sharedGate(),
                    claudeStore: unstubbed("claudeStore", {
                        read: async () => ({ id: "a", accessToken: "test-token", connectedAt: 1 }),
                    }),
                }),
            ),
        );
        // Failed rather than cached as "no grant": a 429 says nothing about whether this account has one.
        await expect(client.limitReset({ account: "a" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
        // That 429 armed the park this endpoint's readers share, so the next strip to appear costs no read at all.
        // Uncached failures are how this probe is meant to recover; without the park they are also how it spends the
        // budget the headroom number depends on.
        await expect(client.limitReset({ account: "a" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
        expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
        fetcher.mockRestore();
    }
});
