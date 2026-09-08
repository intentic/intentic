import { usageContract } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test, vi } from "vitest";
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

test("usage.limitReset answers for an account the store has no credential for, rather than failing the strip that asked", async () => {
    const asked: string[] = [];
    const client = routesClient(
        usageContract,
        createUsageRoutes(
            unstubbed<UsageRoutesDeps>("usage deps", {
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

test("a rate-limited eligibility probe fails over the wire so the client can retry it", async () => {
    const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("{}", { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ juniper_tide: { eligible: true, available: true, arm: "reset" } })));
    try {
        const client = routesClient(
            usageContract,
            createUsageRoutes(
                unstubbed<UsageRoutesDeps>("usage deps", {
                    claudeStore: unstubbed("claudeStore", {
                        read: async () => ({ id: "a", accessToken: "test-token", connectedAt: 1 }),
                    }),
                }),
            ),
        );
        await expect(client.limitReset({ account: "a" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
        expect(await client.limitReset({ account: "a" })).toEqual({ available: true });
    } finally {
        fetcher.mockRestore();
    }
});
