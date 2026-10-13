import type { AccountUsage, ProviderRefusal, UsageWindow } from "@intentic/sandbox-contract";
import { codexConnectedProxy, services, withTranslator } from "../../../harness/route-services.testing.js";
import { spawnBlocked, spawnableProviders, spawnCatalogText } from "../spawn-catalog.js";
import { unstubbed } from "@intentic/testing";
import type { ProviderRefusalStore } from "../../../usage/provider-refusals.js";

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

// The harness values a spawn may name, said only where there is a choice of loop.
test("names a provider's loops where it offers more than one", () => {
    const text = spawnCatalogText([
        { id: "codex", label: "Codex", models: [{ id: "gpt-5.5", label: "GPT-5.5" }], spent: 0, loops: ["codex", "claude-code"] },
        { id: "claude", label: "Claude", models: [{ id: "opus", label: "Opus" }], spent: 0, loops: ["claude-code"] },
    ]);
    expect(text).toBe("codex: gpt-5.5 (not metered); harness: codex (default), claude-code\nclaude: opus (not metered)");
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
            providerRefusals: unstubbed<ProviderRefusalStore>("providerRefusals", { onFile: async () => (refusal === undefined ? {} : { codex: [refusal] }) }),
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
        // A figure on show carries the note that every child started together spends the same one.
        expect(text.split("\n")[0]).toBe(
            "claude: opus (17% left on work@example.com, read 3h ago), sonnet (17% left on home@example.com, read 5h ago, STALE: re-reading it has failed since 4h ago (Verify your account to continue.))",
        );
    });
});

/* Nothing validated a spawn against this listing before: a provider whose plan refused every turn still read "not
   metered", and five children went onto a spent Cursor model in 32 seconds (2026-10-11). The refusal below is what
   makes the listing's own words true. */
describe("a spawn the listing already knows would be refused", () => {
    const cursorWith = (spentModels: readonly { id: string; label: string; reopensAt?: number }[], models: readonly { id: string; label: string }[]) => [
        { id: "cursor" as const, label: "Cursor", models: [...models], spent: spentModels.length, spentModels: [...spentModels] },
        { id: "claude" as const, label: "Claude", models: [{ id: "claude-opus-5-5", label: "Opus" }], spent: 0, spentModels: [] },
    ];

    it("refuses a model the records call spent, naming where the task can go instead", () => {
        const blocked = spawnBlocked(cursorWith([{ id: "claude-opus-5-5", label: "Opus" }], [{ id: "composer-2.5", label: "Composer 2.5" }]), {
            provider: "cursor",
            model: "claude-opus-5-5",
        });

        expect(blocked).toContain("cursor/claude-opus-5-5 is out of allowance");
        // Both ways on, so the retry is one call and not a wait, a failure and a re-spawn.
        expect(blocked).toContain("With room on cursor right now: composer-2.5.");
        expect(blocked).toContain("Other providers with room: claude.");
    });

    // The whole point of the listing is that a plan publishing nothing is listed, not grounded: an unmeasured model may
    // well answer, and refusing it would stop every Cursor and Devin spawn this sandbox can make.
    it("lets an unmeasured model through, since no reading is not no allowance", () => {
        const providers = cursorWith([], [{ id: "composer-2.5", label: "Composer 2.5" }]);

        expect(spawnBlocked(providers, { provider: "cursor", model: "composer-2.5" })).toBeUndefined();
        // A model the catalog never listed either: it is for the provider to refuse, not for this to guess at.
        expect(spawnBlocked(providers, { provider: "cursor", model: "muse-spark-1.3" })).toBeUndefined();
    });

    it("lets a provider nothing on file describes through", () => {
        expect(spawnBlocked([], { provider: "cursor", model: "claude-opus-5-5" })).toBeUndefined();
    });
});

/* Cursor alone publishes 45 models, every one of them reading "(not metered)": ~700 tokens of no information, read
   before every fan-out. */
describe("a provider that meters nothing", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `model-${String(index)}`, label: `Model ${String(index)}` }));

    it("names the first few and counts the rest, rather than printing all of them", () => {
        const text = spawnCatalogText([{ id: "cursor", label: "Cursor", models: many(45), spent: 0 }]);

        expect(text).toContain("cursor: model-0 (not metered)");
        expect(text).toContain("model-7 (not metered), and 37 more not metered (`agents providers --all`)");
        expect(text).not.toContain("model-8 (not metered)");
    });

    it("names every one of them when asked", () => {
        const text = spawnCatalogText([{ id: "cursor", label: "Cursor", models: many(45), spent: 0 }], Date.now(), { all: true });

        expect(text).toContain("model-44 (not metered)");
        expect(text).not.toContain("more not metered");
    });

    // A metered figure is never dropped for an unmetered one: the number is the reason the listing is read.
    it("keeps every metered figure whatever the cap", () => {
        const metered = { id: "measured", label: "Measured", headroom: { percentLeft: 40 } };
        const text = spawnCatalogText([{ id: "cursor", label: "Cursor", models: [...many(20), metered], spent: 0 }]);

        expect(text).toContain("measured (40% left)");
    });
});

// Thirteen Claude children were once started against an account reading "96% left" and all hit the wall together: the
// figure was true and said nothing about spending it thirteen times over.
describe("one account's figure, spent by every child at once", () => {
    it("says that subagents started together draw on it together", () => {
        const text = spawnCatalogText([
            { id: "claude", label: "Claude", models: [{ id: "opus", label: "Opus", headroom: { percentLeft: 96 } }], spent: 0 },
        ]);

        expect(text).toContain("subagents you start together draw on it together");
    });

    // With nothing metered there is no figure to misread, and the sentence would be noise on the listing read most.
    it("says nothing of the sort where no figure is on show", () => {
        const text = spawnCatalogText([{ id: "cursor", label: "Cursor", models: [{ id: "auto", label: "Auto" }], spent: 0 }]);

        expect(text).toBe("cursor: auto (not metered)");
    });
});
