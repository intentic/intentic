import type { AccountUsage, ProviderRefusal, TranslatorAccounts } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { usageContract } from "@intentic/sandbox-contract/contracts/usage.contract";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import { pino } from "pino";
import type { Services } from "../../../composition.js";
import { opt } from "../../../opt.js";
import { proven, routesClient } from "../../../harness/route-client.testing.js";
import { ACCOUNTS_ALL, type AccountReach } from "../../../secrets/credential-reach.js";
import { providerCapacity, provideCapacityPorts } from "../../../usage/serviceability/capacity-feed.js";
import { judgedAccounts } from "../../../usage/serviceability/serviceability.js";
import { createUsageRoutes, type UsageRoutesDeps } from "../../../usage/usage.routes.js";
import { claudeReading } from "../claude/claude-usage.testing.js";
import { beginPulse, endPulse } from "../../run/turn/turn-pulse.js";
import { claudePickModel, coldTarget, moveDestinationFor, moveTarget, pinOrder, placementFor, type PlacementDeps, unnamedAmong, unnamedPlacement } from "./placement.js";

/* EVERY "WHICH ACCOUNT DOES THIS RUN ON" IS ANSWERED BY ONE MODULE (placement.ts), in four variants: a turn naming no
   account, a move off an account that cannot serve, a cold conversation's re-placement, and a routed request's pin
   order. Each used to be answered by the subsystem that asked, and only two of them counted what already ran on each
   account (2026-11-19). These pin each variant, that the capacity every window draws is the very pick a turn makes,
   and that usage.placement answers the turn its asker would send. */

const OPUS = "claude-opus-5-5";
const NOW_S = Math.floor(Date.now() / 1000);
const account = (id: string, extra: Partial<OauthAccount> = {}): OauthAccount => ({ id, label: id, connectedAt: 0, ...extra });
// A weekly pool `used` points spent, renewing `renewsInH` hours from now, measured a minute ago.
const weekly = (used: number, renewsInH: number): AccountUsage => ({
    windows: [{ kind: "seven_day", utilization: used, gates: "all", resetsAt: NOW_S + renewsInH * 3_600 }],
    measuredAt: Date.now() - 60_000,
});
// A Claude five-hour pool `used` points spent, as the reader files it.
const fiveHour = (used: number): AccountUsage => claudeReading({ five_hour: { utilization: used } });
const limit = (accountId: string, model?: string): ProviderRefusal => ({
    at: Date.now() - 1_000,
    kind: "limit",
    message: "Usage limit reached.",
    account: accountId,
    ...opt("model", model),
});

// What the fan-out planner projects from, with nothing learned: a prior pace for every model.
const PLANNER = {
    burnRates: { ready: async () => {}, tokensPerPoint: () => undefined, modelPace: () => undefined, reading: async () => {}, turnEnded: async () => {} },
    runOuts: { read: async () => ({}), record: async () => {} },
    sandboxSettings: { get: async () => SandboxSettingsSchema.parse({}) },
};

interface Fleet {
    readonly claude?: readonly OauthAccount[];
    // Claude's readings, by account.
    readonly usage?: Record<string, AccountUsage>;
    // Every refusal on file, by provider.
    readonly refusals?: Record<string, readonly ProviderRefusal[]>;
    // The accounts a provider's own door lists (Cursor, Devin, the minted keys, a vendor CLI's sign-ins).
    readonly doors?: Record<string, readonly OauthAccount[]>;
    readonly routed?: Partial<TranslatorAccounts>;
    // Whether the services carry what the planner projects from, as the daemon's do.
    readonly planner?: boolean;
}

const deps = (fleet: Fleet = {}): PlacementDeps => {
    const services: PlacementDeps = {
        claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => [...(fleet.claude ?? [])] }),
        claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => ({}) }),
        accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => fleet.usage ?? {} }),
        providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", {
            onFile: async () => fleet.refusals ?? {},
            flapping: async () => new Set(),
            switchOffs: async () => ({}),
        }),
        providerAccounts: async (provider) => [...(fleet.doors?.[provider] ?? [])],
        cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", { accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [], ...fleet.routed }) }),
        providerCatalogs: unstubbed<Services["providerCatalogs"]>("providerCatalogs", {
            claude: { models: async () => ({ models: [], default: OPUS }) },
        }),
        // The verdict's state lines are not what these tests read.
        logger: pino({ level: "silent" }),
    };
    return fleet.planner === true ? { ...services, ...PLANNER } : services;
};

// Six of this sandbox's turns running on one Claude account, for as long as `body` runs.
const crowding = async <T>(accountId: string, body: () => Promise<T>): Promise<T> => {
    const ids = Array.from({ length: 6 }, (_, index) => `crowd-${String(index)}`);
    for (const conversationId of ids) {
        beginPulse({ conversationId, turnId: `t-${conversationId}`, provider: "claude", harness: "native", model: OPUS, account: accountId, startedAt: Date.now() });
    }
    try {
        return await body();
    } finally {
        for (const conversationId of ids) {
            endPulse(conversationId, `t-${conversationId}`);
        }
    }
};

// Two Claude accounts with room, the one reading more of it crowded with this sandbox's turns.
const CROWDED: Fleet = { claude: [account("crowded"), account("quiet")], usage: { crowded: fiveHour(30), quiet: fiveHour(40) } };

describe("a turn naming no account", () => {
    // 2026-11-17: Claude's Ultra plan meters only weekly windows; spending the pool that resets first wastes the least.
    it("runs on the allowance that renews first, unless it is nearly out", async () => {
        const services = deps({ claude: [account("later"), account("sooner")], usage: { later: weekly(30, 144), sooner: weekly(60, 10) } });
        expect((await unnamedPlacement(services, "claude", await services.claudeStore.list(), OPUS))?.id).toBe("sooner");
        const nearlyOut = deps({ claude: [account("later"), account("sooner")], usage: { later: weekly(30, 144), sooner: weekly(95, 10) } });
        expect((await unnamedPlacement(nearlyOut, "claude", await nearlyOut.claudeStore.list(), OPUS))?.id).toBe("later");
    });

    it("counts what already runs on each account where the planner carries the provider", async () => {
        await crowding("crowded", async () => {
            const verdictsAlone = deps(CROWDED);
            expect((await unnamedPlacement(verdictsAlone, "claude", await verdictsAlone.claudeStore.list(), OPUS))?.id).toBe("crowded");
            const loaded = deps({ ...CROWDED, planner: true });
            expect((await unnamedPlacement(loaded, "claude", await loaded.claudeStore.list(), OPUS))?.id).toBe("quiet");
        });
    });

    it("places a provider that publishes no allowance by what its accounts have refused, among the ones its loop holds", async () => {
        const services = deps({ doors: { devin: [account("first"), account("second")] }, refusals: { devin: [limit("first", "swe-1-6")] } });
        expect((await unnamedPlacement(services, "devin", [{ id: "first" }, { id: "second" }], "swe-1-6"))?.id).toBe("second");
        // The runtime's own list decides which accounts are candidates: one it cannot serve on is never picked.
        expect((await unnamedPlacement(services, "devin", [{ id: "first" }], "swe-1-6"))?.id).toBe("first");
    });

    it("keeps the first account where the verdicts cannot be read", async () => {
        const unreadable: PlacementDeps = {
            ...deps({ claude: [account("one"), account("two")] }),
            accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", {
                read: async () => {
                    throw new Error("disk gone");
                },
            }),
        };
        expect((await unnamedPlacement(unreadable, "claude", [{ id: "one" }, { id: "two" }], OPUS))?.id).toBe("one");
    });

    it("pins a member held to some accounts to the same pick among those, load counted", async () => {
        await crowding("crowded", async () => {
            const services = deps({ claude: [account("crowded"), account("quiet"), account("theirs")], usage: { crowded: fiveHour(30), quiet: fiveHour(40), theirs: fiveHour(50) }, planner: true });
            const rows = await judgedAccounts(services, "claude", { id: OPUS });
            expect((await unnamedAmong(services, "claude", rows, OPUS))?.id).toBe("quiet");
            expect((await unnamedAmong(services, "claude", rows.filter((row) => row.id !== "quiet"), OPUS))?.id).toBe("theirs");
        });
    });
});

describe("a move off an account that cannot serve", () => {
    it("lands only on proven room, never back on the account it leaves", async () => {
        const services = deps({ claude: [account("spent"), account("half"), account("unmeasured")], usage: { spent: fiveHour(100), half: fiveHour(50) } });
        expect(await moveDestinationFor(services, "claude", OPUS, { from: "spent" })).toBe("half");
        expect(await moveDestinationFor(services, "claude", OPUS, { from: "half" })).toBeUndefined();
    });

    it("lands on an account nothing has refused where the provider publishes no allowance", async () => {
        const services = deps({ doors: { devin: [account("first"), account("second")] }, refusals: { devin: [limit("first")] } });
        expect(await moveDestinationFor(services, "devin", "swe-1-6", { from: "first" })).toBe("second");
    });

    it("lands where the planner places the turn once the load is counted, among the accounts the people may use", async () => {
        await crowding("crowded", async () => {
            const services = deps({ ...CROWDED, claude: [account("spent"), ...(CROWDED.claude ?? [])], usage: { ...CROWDED.usage, spent: fiveHour(100) }, planner: true });
            expect(await moveDestinationFor(services, "claude", OPUS, { from: "spent" })).toBe("quiet");
            expect(await moveDestinationFor(services, "claude", OPUS, { from: "spent", allows: (id) => id !== "quiet" })).toBe("crowded");
            const others = (await judgedAccounts(services, "claude", { id: OPUS })).filter((row) => row.id !== "spent");
            expect((await moveTarget(services, "claude", OPUS, others))?.id).toBe("quiet");
        });
    });

    it("answers nothing for a routed provider, whose gateway already tried every account", async () => {
        const services = deps({ routed: { codex: [{ name: "a.json", label: "a" }, { name: "b.json", label: "b" }] } });
        expect(await moveDestinationFor(services, "codex", "gpt-6.1-sol", { from: "a.json" })).toBeUndefined();
    });
});

describe("a cold conversation's re-placement", () => {
    it("is offered proven room alone, the planner's pick first", async () => {
        await crowding("crowded", async () => {
            const fleet = { claude: [account("here"), account("crowded"), account("quiet"), account("unmeasured")], usage: { here: fiveHour(80), crowded: fiveHour(30), quiet: fiveHour(40) } };
            const others = async (services: PlacementDeps) => (await judgedAccounts(services, "claude", { id: OPUS })).filter((row) => row.id !== "here");
            const verdictsAlone = deps(fleet);
            expect((await coldTarget(verdictsAlone, "claude", OPUS, await others(verdictsAlone)))?.id).toBe("crowded");
            const loaded = deps({ ...fleet, planner: true });
            expect((await coldTarget(loaded, "claude", OPUS, await others(loaded)))?.id).toBe("quiet");
            const unmeasured = (await others(verdictsAlone)).filter((row) => row.id === "unmeasured");
            expect(await coldTarget(verdictsAlone, "claude", OPUS, unmeasured)).toBeUndefined();
        });
    });
});

describe("a routed request's pin order", () => {
    // 2026-11-13: a spent account left out of the order was never asked again, so its refusal was never settled.
    it("asks every account that can serve best first, then the spent ones refused longest ago, two at most", async () => {
        const reading = (used: number): AccountUsage => weekly(used, 48);
        const services = deps({
            routed: {
                codex: [
                    { name: "busy.json", label: "busy", usage: reading(80) },
                    { name: "roomy.json", label: "roomy", usage: reading(10) },
                    { name: "unread.json", label: "unread" },
                    { name: "spent-new.json", label: "spent-new", usage: reading(20) },
                    { name: "spent-old.json", label: "spent-old", usage: reading(20) },
                    { name: "spent-oldest.json", label: "spent-oldest", usage: reading(20) },
                    { name: "benched.json", label: "benched", cooling: { until: NOW_S + 3_600, reason: "rested" } },
                ],
            },
            refusals: {
                codex: [
                    { ...limit("spent-new.json"), at: Date.now() - 1_000, resetsAt: NOW_S + 3_600 },
                    { ...limit("spent-old.json"), at: Date.now() - 5_000, resetsAt: NOW_S + 3_600 },
                    { ...limit("spent-oldest.json"), at: Date.now() - 9_000, resetsAt: NOW_S + 3_600 },
                ],
            },
        });
        expect(await pinOrder(services, "codex", "gpt-6.1-sol")).toEqual(["roomy.json", "busy.json", "unread.json", "spent-oldest.json", "spent-old.json"]);
        // The gateway's own narrowing (an account the translator knows by a prefix) applies before the probes are counted.
        expect(await pinOrder(services, "codex", "gpt-6.1-sol", (id) => id !== "spent-oldest.json")).toEqual(["roomy.json", "busy.json", "unread.json", "spent-old.json", "spent-new.json"]);
    });
});

describe("the placement every window draws", () => {
    it("is the very pick a turn naming no account makes, load counted", async () => {
        await crowding("crowded", async () => {
            const services = deps({ ...CROWDED, planner: true });
            const undo = provideCapacityPorts({ placementOf: (provider, model, narrow) => placementFor(services, provider, model, narrow) });
            try {
                const capacity = await providerCapacity(services, "claude");
                // What a Claude turn naming no account runs on (harness-credentials.ts): the store's accounts, judged for the
                // catalog's default model.
                const turn = await unnamedPlacement(services, "claude", await services.claudeStore.list(), (await claudePickModel(services, undefined))?.id);
                expect(capacity.placement).toBe("quiet");
                expect(turn?.id).toBe(capacity.placement);
            } finally {
                undo();
            }
        });
    });

    it("is the pick a door's turn makes too", async () => {
        const services = deps({ doors: { devin: [account("first"), account("second")] }, refusals: { devin: [limit("first")] } });
        const undo = provideCapacityPorts({ placementOf: (provider, model, narrow) => placementFor(services, provider, model, narrow) });
        try {
            const capacity = await providerCapacity(services, "devin");
            expect(capacity.placement).toBe("second");
            expect((await unnamedPlacement(services, "devin", [{ id: "first" }, { id: "second" }], undefined))?.id).toBe(capacity.placement);
        } finally {
            undo();
        }
    });
});

// 2026-11-19: usage.placement answered the sandbox-wide pick on the default loop, and a window whose rows left that
// account out (a member held to some accounts, a loop whose sign-ins are its own) predicted its own pick instead.
describe("usage.placement", () => {
    const ann = "ann@example.com";
    // Ann may run on Claude's "theirs" alone; nobody limits the owner.
    const reach = async (_conversation: string | undefined, also: readonly string[] = []): Promise<AccountReach> =>
        also.includes(ann) ? { kind: "some", lists: [new Set(["claude:theirs"])], who: [ann] } : ACCOUNTS_ALL;
    const client = (fleet: Fleet, identity?: ReturnType<typeof proven>) => {
        const services = deps(fleet);
        const undo = provideCapacityPorts({ placementOf: (provider, model, narrow) => placementFor(services, provider, model, narrow) });
        const routes = createUsageRoutes(unstubbed<UsageRoutesDeps>("usage deps", { ...services, accountReach: reach }));
        return { api: routesClient(usageContract, routes, identity), undo };
    };

    it("answers the asker's own turn: among the accounts they may run on", async () => {
        const fleet: Fleet = { claude: [account("owners"), account("theirs")], usage: { owners: fiveHour(10), theirs: fiveHour(60) } };
        const owner = client(fleet);
        try {
            expect(await owner.api.placement({ provider: "claude" })).toMatchObject({ account: "owners", narrowed: true });
        } finally {
            owner.undo();
        }
        const member = client(fleet, proven(ann, "collaborator"));
        try {
            expect(await member.api.placement({ provider: "claude", model: OPUS })).toMatchObject({ account: "theirs", narrowed: true });
            expect(await member.api.placement({ provider: "devin" })).toEqual({ judgedAt: expect.any(Number), narrowed: true });
        } finally {
            member.undo();
        }
    });

    it("answers on the loop asked about: a vendor CLI's own sign-ins, or the subscriptions the gateway pins", async () => {
        const fleet: Fleet = {
            doors: { kimi: [account("cli-a", { variant: "kimi-cli" }), account("cli-b", { variant: "kimi-cli" })] },
            routed: { kimi: [{ name: "sub-a.json", label: "sub-a", usage: weekly(90, 48) }, { name: "sub-b.json", label: "sub-b", usage: weekly(10, 48) }] },
            refusals: { kimi: [limit("cli-a")] },
        };
        const owner = client(fleet);
        try {
            expect(await owner.api.placement({ provider: "kimi", loop: "vendor" })).toMatchObject({ account: "cli-b" });
            expect(await owner.api.placement({ provider: "kimi" })).toMatchObject({ account: "sub-b.json" });
            // A loop this daemon does not know is the provider's default.
            expect(await owner.api.placement({ provider: "kimi", loop: "a-loop-from-later" })).toMatchObject({ account: "sub-b.json" });
        } finally {
            owner.undo();
        }
    });
});
