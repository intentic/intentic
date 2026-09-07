import type { AccountUsage, UsageWindow } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { codexConnectedProxy, services, withTranslator } from "../../harness/route-services.testing.js";
import { spawnableProviders, spawnCatalogText } from "./spawn-catalog.js";

/* WHAT A PARENT MAY SPEND ON A CHILD, which the spawn door now requires it to name (children.ts): `provider`
 * and `model` are mandatory, so this listing is the half that makes the requirement fair.
 *
 * What is pinned here is the three states staying apart, because they call for different things next: a
 * measured pool with room (a number the caller can compare), a measured pool that is FULL (left out entirely —
 * the listing is what can actually run — with the provider's own renewal instant kept so the row can say when
 * it comes back), and NOTHING MEASURED, which is the honest answer for Cursor, for a user's own endpoint, and
 * for an account never polled. The last one is listed rather than dropped: "no reading" is not "no allowance",
 * and hiding a working provider behind a gap in our own bookkeeping is the failure mode this file exists to
 * avoid. */

const window = (over: Partial<UsageWindow> & Pick<UsageWindow, "kind">): UsageWindow => ({ utilization: 10, gates: "all", ...over });
const usage = (...windows: UsageWindow[]): AccountUsage => ({ windows, measuredAt: 1_000 });

// Claude connected with two accounts, and nothing else: `testProviderCatalogs` answers for every provider, so
// readiness is what decides which rows appear at all.
const claudeOnly = (accounts: Record<string, AccountUsage>) =>
    services({
        claudeStore: { list: async () => Object.keys(accounts).map((id) => ({ id, label: id })) as never },
        accountUsage: { read: async () => accounts, record: async () => {}, clear: async () => {} },
    });

test("reports the most headroom any one account has, and names only a pool the plan scopes", async () => {
    const spent = { kind: "seven_day", label: "Weekly", gates: "all" } as const;
    const rows = await spawnableProviders(
        claudeOnly({
            tired: usage(window({ ...spent, utilization: 91 })),
            fresh: usage(window({ ...spent, utilization: 40 })),
        }),
    );
    const claude = rows.find((row) => row.id === "claude");
    // The BEST account answers: one account with room is enough to run the turn.
    expect(claude?.models[0]?.headroom).toEqual({ percentLeft: 60 });
    expect(claude?.spent).toBe(0);
});

test("names a pool the plan meters separately, so the number says which allowance it is about", async () => {
    const rows = await spawnableProviders(
        claudeOnly({ one: usage(window({ kind: "opus_weekly", label: "Opus", gates: { models: ["opus"] }, utilization: 25 })) }),
    );
    expect(rows.find((row) => row.id === "claude")?.models[0]?.headroom).toEqual({ percentLeft: 75, pool: "Opus" });
});

test("leaves out a model whose every account is at the cap, and keeps when it comes back", async () => {
    const full = { kind: "seven_day", label: "Weekly", gates: "all" } as const;
    const rows = await spawnableProviders(
        claudeOnly({
            a: usage(window({ ...full, utilization: 100, resetsAt: 9_000 })),
            b: usage(window({ ...full, utilization: 100, resetsAt: 4_000 })),
        }),
    );
    const claude = rows.find((row) => row.id === "claude");
    expect(claude?.models).toEqual([]);
    expect(claude?.spent).toBe(1);
    // The SOONEST of them, since any one pool reopening makes the provider spendable again.
    expect(claude?.reopensAt).toBe(4_000);
});

test("lists a model nothing measures rather than dropping it: no reading is not no allowance", async () => {
    // An account on file with no windows at all is the unmeasured case, and it must not read as spent.
    const rows = await spawnableProviders(claudeOnly({ never_polled: usage() }));
    const claude = rows.find((row) => row.id === "claude");
    expect(claude?.models).toEqual([{ id: "opus", label: "Opus" }]);
    expect(claude?.spent).toBe(0);
});

/* A COOLING credential is one the translator is routing around right now, whatever its last quota reading
 * says, so its headroom must not be advertised: a percentage taken off an account nothing can reach is worse
 * than no percentage at all. */
test("does not count an account the proxy is routing around", async () => {
    const roomy = usage(window({ kind: "seven_day", label: "Weekly", gates: "all", utilization: 5 }));
    const composed = services({
        claudeStore: { list: async () => [] as never },
        // Codex authenticates through the translator, so its readiness rung needs one configured before the row
        // reaches the listing at all; the cooling flag is what this test is actually about.
        config: withTranslator,
        cliProxy: {
            ...codexConnectedProxy,
            accounts: async () => ({
                codex: [{ name: "codex-user.json", label: "user@example.com", usage: roomy, cooling: { until: 2_000 } }],
                grok: [],
                kimi: [],
                gemini: [],
            }),
        },
    });
    const codex = (await spawnableProviders(composed)).find((row) => row.id === "codex");
    // Cooling counts as spent, so the model is out of the listing rather than shown with 95% left.
    expect(codex?.models).toEqual([]);
    expect(codex?.spent).toBe(1);
});

test("says nothing is connected as a sentence, rather than as an empty listing", () => {
    expect(spawnCatalogText([])).toMatch(/No AI provider is connected/);
});

test("renders each of the three states in its own words", () => {
    const text = spawnCatalogText(
        [
            { id: "claude", label: "Claude", models: [{ id: "opus", label: "Opus", headroom: { percentLeft: 60, pool: "Weekly" } }], spent: 0 },
            { id: "cursor", label: "Cursor", models: [{ id: "auto", label: "Auto" }], spent: 0 },
            { id: "codex", label: "Codex", models: [], spent: 2, reopensAt: Math.floor(Date.now() / 1000) + 3 * 3_600 },
        ],
        Date.now(),
    );
    expect(text).toContain("claude: opus (Weekly 60% left)");
    // Unmetered is said as itself: Cursor publishes no quota, and inventing a number for it would be a lie.
    expect(text).toContain("cursor: auto (not metered)");
    expect(text).toContain("codex: every model is out of allowance, renews in about 3h");
});
