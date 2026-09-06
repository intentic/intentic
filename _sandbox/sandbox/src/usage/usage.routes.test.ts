import { usageContract } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import type { UsageRoutesDeps } from "./usage.routes.js";
import { createUsageRoutes } from "./usage.routes.js";
import { routesClient } from "../harness/route-client.testing.js";

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

/* The session-limit reset, over the one seam THESE routes have: Claude's credential store. What the reset
 * itself is, and every shape the provider answers with, is claude-limit-reset.test.ts next door; this is about
 * the route reaching the named account and answering rather than throwing for one it has never heard of.
 *
 * An account the store cannot produce a token for is the case worth pinning here, because it is the one a
 * client hits by asking about any account it holds without first knowing which provider grants a reset: it has
 * to come back as "nothing available", never as a failure that would break the strip drawing the refusal. */
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
    // A claim on the same account says what would have to change, in words somebody can act on, and posts
    // nothing: there is no credential to post with.
    expect(await client.claimLimitReset({ account: "nobody" })).toMatchObject({ result: "error", detail: expect.stringContaining("Reconnect") });
    expect(asked).toEqual(["nobody", "nobody"]);
});
