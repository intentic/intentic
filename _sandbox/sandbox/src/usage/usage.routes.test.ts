import { usageContract } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import type { UsageRoutesDeps } from "./usage.routes.js";
import { createUsageRoutes } from "./usage.routes.js";
import { routesClient } from "../route-testing.js";

/* The usage routes, over the one seam they read.
 *
 * Split out of app.integration.test.ts: 116 tests over every route in the daemon, in one file, and then
 * stood up on `UsageRoutesDeps` rather than on the daemon. `Pick<Services, "usage">` is the whole surface these
 * routes can reach, so nothing the daemon grows later lands in this file's blast radius: it is not in the type. */

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
    // The query reaches the store as day strings, so the store owns the range semantics (inclusive bounds).
    expect(asked).toEqual([{ from: "2026-07-01", to: "2026-07-31" }]);
});
