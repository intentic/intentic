import type { AccountUsage, UsageWindow } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { codexConnectedProxy, services, withTranslator } from "../../harness/route-services.testing.js";
import { spawnableProviders, spawnCatalogText } from "./spawn-catalog.js";

// Pins the three account states this listing must tell apart: measured with room, measured and full (excluded, but
// keeps the reopen instant), and unmeasured (listed, since no reading isn't no allowance).

const window = (over: Partial<UsageWindow> & Pick<UsageWindow, "kind">): UsageWindow => ({ utilization: 10, gates: "all", ...over });
const usage = (...windows: UsageWindow[]): AccountUsage => ({ windows, measuredAt: 1_000 });

// Claude connected with two accounts and nothing else; testProviderCatalogs answers for every provider, so readiness
// alone decides which rows appear.
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
    // The best account answers: one with room is enough to run the turn.
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
    // The soonest reopen wins, since any one pool reopening makes the provider spendable again.
    expect(claude?.reopensAt).toBe(4_000);
});

test("lists a model nothing measures rather than dropping it: no reading is not no allowance", async () => {
    // An account on file with no windows at all is the unmeasured case; it must not read as spent.
    const rows = await spawnableProviders(claudeOnly({ never_polled: usage() }));
    const claude = rows.find((row) => row.id === "claude");
    expect(claude?.models).toEqual([{ id: "opus", label: "Opus" }]);
    expect(claude?.spent).toBe(0);
});

// A cooling credential is being routed around right now, whatever its quota reading says, so its headroom must not be
// advertised.
test("does not count an account the proxy is routing around", async () => {
    const roomy = usage(window({ kind: "seven_day", label: "Weekly", gates: "all", utilization: 5 }));
    const composed = services({
        claudeStore: { list: async () => [] as never },
        // Codex authenticates through the translator, so a configured one is needed before the row appears at all.
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
    // Cooling counts as spent: the model drops from the listing rather than showing 95% left.
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
    // Unmetered is said as itself: Cursor publishes no quota, and inventing a number would be a lie.
    expect(text).toContain("cursor: auto (not metered)");
    expect(text).toContain("codex: every model is out of allowance, renews in about 3h");
});
