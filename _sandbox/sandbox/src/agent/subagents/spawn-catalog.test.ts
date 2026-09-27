import type { AccountUsage, ProviderRefusal, UsageWindow } from "@intentic/sandbox-contract";
import { codexConnectedProxy, services, withTranslator } from "../../harness/route-services.testing.js";
import { spawnableProviders, spawnCatalogText } from "./spawn-catalog.js";
import { unstubbed } from "@intentic/testing";
import type { ProviderRefusalStore } from "../../usage/provider-refusals.js";

// Pins the three account states this listing must tell apart: measured with room, measured and full (excluded, but
// keeps the reopen instant), and unmeasured (listed, since no reading isn't no allowance).

const window = (over: Partial<UsageWindow> & Pick<UsageWindow, "kind">): UsageWindow => ({ utilization: 10, gates: "all", ...over });
const usage = (...windows: UsageWindow[]): AccountUsage => ({ windows, measuredAt: 1_000 });

// Claude connected with two accounts and nothing else; testProviderCatalogs answers for every provider, so readiness
// alone decides which rows appear.
const claudeOnly = (accounts: Record<string, AccountUsage>) =>
    services({
        claudeStore: { list: async () => Object.keys(accounts).map((id) => ({ id, label: id })) as never },
        accountUsage: { read: async () => accounts, record: async () => {}, markUnread: async () => undefined, clear: async () => {} },
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
    // Says whose figure it is and when it was read, since the two accounts read very differently.
    expect(claude?.models[0]?.headroom).toEqual({ percentLeft: 60, account: "fresh", readAt: 1_000 });
    expect(claude?.spent).toBe(0);
});

test("names a pool the plan meters separately, so the number says which allowance it is about", async () => {
    const rows = await spawnableProviders(
        claudeOnly({ one: usage(window({ kind: "opus_weekly", label: "Opus", gates: { models: ["opus"] }, utilization: 25 })) }),
    );
    expect(rows.find((row) => row.id === "claude")?.models[0]?.headroom).toEqual({ percentLeft: 75, pool: "Opus", account: "one", readAt: 1_000 });
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
                // Benched until a retry instant still ahead: one already past has lifted, and the reading speaks again.
                codex: [{ name: "codex-user.json", label: "user@example.com", usage: roomy, cooling: { until: Math.floor(Date.now() / 1000) + 600 } }],
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

// Codex once listed at 100% left minutes before every turn failed "You've hit your usage limit… try again at 3:38 PM":
// its usage endpoint kept reading room. The refusal the failed turn files is what the next listing believes.
describe("a provider's refusal, read in the very next listing", () => {
    const NOW_S = Math.floor(Date.now() / 1000);
    const roomy = (measuredAt: number) => ({ windows: [window({ kind: "five_hour", label: "5h", gates: "all", utilization: 0 })], measuredAt });
    const codexWith = (refusal: ProviderRefusal | undefined, measuredAt = Date.now()) =>
        services({
            // SAFETY: an empty list satisfies every account row type the store's `list` could be typed to return.
            claudeStore: { list: async () => [] as never },
            config: withTranslator,
            providerRefusals: unstubbed<ProviderRefusalStore>("providerRefusals", { read: async () => (refusal === undefined ? {} : { codex: refusal }) }),
            cliProxy: {
                ...codexConnectedProxy,
                accounts: async () => ({
                    codex: [{ name: "codex-user.json", label: "user@example.com", usage: roomy(measuredAt) }],
                    grok: [],
                    kimi: [],
                    gemini: [],
                }),
            },
        });

    it("lists a provider whose plan just refused as spent until the instant it named, over a reading of room", async () => {
        const refusal: ProviderRefusal = { at: Date.now() - 60_000, kind: "limit", message: "You've hit your usage limit.", resetsAt: NOW_S + 3 * 3_600 };
        // Even a reading taken after the refusal, still showing 0% used, does not answer the provider's own words.
        const codex = (await spawnableProviders(codexWith(refusal))).find((row) => row.id === "codex");
        expect(codex?.models).toEqual([]);
        expect(codex?.spent).toBe(1);
        expect(codex?.reopensAt).toBe(NOW_S + 3 * 3_600);
        expect(spawnCatalogText(codex === undefined ? [] : [codex])).toBe("codex: every model is out of allowance, renews in about 3h");
    });

    it("lets the provider back once the instant it named has passed", async () => {
        const refusal: ProviderRefusal = { at: Date.now() - 4 * 3_600_000, kind: "limit", message: "You've hit your usage limit.", resetsAt: NOW_S - 60 };
        const codex = (await spawnableProviders(codexWith(refusal))).find((row) => row.id === "codex");
        expect(codex?.models[0]?.headroom).toMatchObject({ percentLeft: 100, account: "user@example.com" });
        expect(codex?.spent).toBe(0);
    });

    it("lists as before with no refusal on file", async () => {
        const codex = (await spawnableProviders(codexWith(undefined))).find((row) => row.id === "codex");
        expect(codex?.models[0]?.headroom).toMatchObject({ percentLeft: 100, account: "user@example.com" });
    });
});

// Claude once sat at "17% left" for hours on a reading that could no longer be re-read.
describe("whose figure it is, and how old", () => {
    const weekly = (utilization: number) => window({ kind: "seven_day", label: "Weekly", gates: "all", utilization });

    it("quotes a reading that can still be re-read over a roomier one that cannot", async () => {
        const rows = await spawnableProviders(
            claudeOnly({
                stuck: { windows: [weekly(10)], measuredAt: 1_000, unread: { since: 2_000, reason: "Verify your account to continue." } },
                live: { windows: [weekly(83)], measuredAt: 5_000 },
            }),
        );
        expect(rows.find((row) => row.id === "claude")?.models[0]?.headroom).toEqual({ percentLeft: 17, account: "live", readAt: 5_000 });
    });

    it("marks a stale figure stale, with how long re-reading it has failed, when it is all there is", async () => {
        const rows = await spawnableProviders(
            claudeOnly({ stuck: { windows: [weekly(83)], measuredAt: 1_000, unread: { since: 2_000, reason: "Verify your account to continue." } } }),
        );
        expect(rows.find((row) => row.id === "claude")?.models[0]?.headroom).toEqual({
            percentLeft: 17,
            account: "stuck",
            readAt: 1_000,
            stale: { since: 2_000, reason: "Verify your account to continue." },
        });
    });

    it("says whose figure it is and how old its reading is, and a stale one as stale", () => {
        const now = Date.UTC(2026, 8, 27, 12, 0);
        const text = spawnCatalogText(
            [
                {
                    id: "claude",
                    label: "Claude",
                    models: [
                        { id: "opus", label: "Opus", headroom: { percentLeft: 17, account: "work@example.com", readAt: now - 3 * 3_600_000 } },
                        {
                            id: "sonnet",
                            label: "Sonnet",
                            headroom: {
                                percentLeft: 17,
                                account: "home@example.com",
                                readAt: now - 5 * 3_600_000,
                                stale: { since: now - 4 * 3_600_000, reason: "Verify your account to continue." },
                            },
                        },
                    ],
                    spent: 0,
                },
            ],
            now,
        );
        expect(text).toBe(
            "claude: opus (17% left on work@example.com, read 3h ago), sonnet (17% left on home@example.com, read 5h ago, STALE: re-reading it has failed since 4h ago (Verify your account to continue.))",
        );
    });
});
