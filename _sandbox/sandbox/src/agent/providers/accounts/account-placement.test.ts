import type { AccountUsage, ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { PROMPT_CACHE_1H_MS, PROMPT_CACHE_5M_MS } from "../../run/turn/prompt-cache.js";
import { claudeReading } from "../claude/claude-usage.testing.js";
import { cacheCold, type ColdTurn, NEAR_SPENT, offSpentAccount, placeCold, REPLACE_GAP } from "./account-placement.js";
import type { BlockedAccountDeps } from "./blocked-account.js";

// Where a conversation runs once its cache has gone cold: kept where it is unless another account has clearly more room
// and nobody pinned this one. Moving off an account that cannot serve is blocked-account.test.ts's.

// A Claude account's five-hour pool, as the reader files it (rounded).
const reading = (utilization: number): AccountUsage => claudeReading({ five_hour: { utilization } });

const deps = (usage: Record<string, AccountUsage>): BlockedAccountDeps => ({
    claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => [...TWO] }),
    claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => ({}) }),
    claudeSeatCheck: unstubbed<Services["claudeSeatCheck"]>("claudeSeatCheck", {}),
    accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => usage }),
    providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => ({}) }),
    providerAccounts: async () => [],
    cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {}),
});

// SAFETY: the rule reads only an account's id and label; the rest of a stored row is the store's own business.
const TWO = [
    { id: "home", label: "home" },
    { id: "spare", label: "spare" },
] as OauthAccount[];

const cold: ColdTurn = { provider: "claude", named: undefined, remembered: "home", pinned: false, cold: true, model: undefined };

test("a cold, unpinned conversation moves to an account with at least the gap more room, saying both rooms", async () => {
    expect(await placeCold(deps({ home: reading(70), spare: reading(70 - REPLACE_GAP) }), cold)).toEqual({
        kind: "move",
        from: "home",
        to: "spare",
        labels: { from: "home", to: "spare" },
        reason: `"home" had 30% left and "spare" 50% left; the cache had gone cold, so moving cost nothing`,
        cold: true,
    });
});

test("a small difference in room is not worth a move", async () => {
    expect(await placeCold(deps({ home: reading(50), spare: reading(50 - REPLACE_GAP + 1) }), cold)).toEqual({ kind: "keep" });
});

test("an account nearly out moves for any gain", async () => {
    const nearlyOut = 100 - NEAR_SPENT;
    expect(await placeCold(deps({ home: reading(nearlyOut), spare: reading(nearlyOut - 5) }), cold)).toMatchObject({ kind: "move", to: "spare" });
});

test("a warm cache, a pinned account, a named one and none on file all stay where routing points", async () => {
    const roomier = deps({ home: reading(90), spare: reading(10) });
    expect(await placeCold(roomier, { ...cold, cold: false })).toEqual({ kind: "keep" });
    expect(await placeCold(roomier, { ...cold, pinned: true })).toEqual({ kind: "keep" });
    expect(await placeCold(roomier, { ...cold, named: "home" })).toEqual({ kind: "keep" });
    expect(await placeCold(roomier, { ...cold, remembered: undefined })).toEqual({ kind: "keep" });
});

// Unmeasured is usable but never read as room: neither a reason to leave nor a place to go.
test("an unmeasured account neither moves nor is moved onto", async () => {
    expect(await placeCold(deps({ spare: reading(10) }), cold)).toEqual({ kind: "keep" });
    expect(await placeCold(deps({ home: reading(95) }), cold)).toEqual({ kind: "keep" });
});

describe("whether the cache is cold", () => {
    const now = 10 * PROMPT_CACHE_1H_MS;

    test("a known lifetime decides it", () => {
        expect(cacheCold({ at: now - PROMPT_CACHE_5M_MS + 1, ttlMs: PROMPT_CACHE_5M_MS }, now, now)).toBe(false);
        expect(cacheCold({ at: now - PROMPT_CACHE_5M_MS, ttlMs: PROMPT_CACHE_5M_MS }, now, now)).toBe(true);
    });

    test("with none known, quiet for the longest lifetime any provider offers is cold, and so is no record at all", () => {
        expect(cacheCold(undefined, now - PROMPT_CACHE_1H_MS + 1, now)).toBe(false);
        expect(cacheCold(undefined, now - PROMPT_CACHE_1H_MS, now)).toBe(true);
        expect(cacheCold(undefined, undefined, now)).toBe(true);
    });
});

// Off a spent allowance before the turn is sent to be refused, pinned or not: the 2026-10-29 Devin chat, refused twice on
// a spent account with two accounts beside it that nothing had refused.
describe("a conversation remembering an account the records call spent", () => {
    // SAFETY: the rule reads only an account's id and label, as TWO above.
    const DEVIN = [
        { id: "spent", label: "radarsu@gmail.com" },
        { id: "second", label: "second" },
        { id: "third", label: "third" },
    ] as OauthAccount[];
    const quota: ProviderRefusal = { at: Date.now(), kind: "limit", message: "Your weekly usage quota has been exhausted.", account: "spent", model: "swe-1-6-slow" };
    const devin = (refusals: readonly ProviderRefusal[], accounts: readonly OauthAccount[] = DEVIN): BlockedAccountDeps => ({
        ...deps({}),
        providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => ({ devin: refusals }) }),
        providerAccounts: async (provider) => (provider === "devin" ? [...accounts] : []),
    });
    const turn = { provider: "devin", named: undefined, remembered: "spent", model: "swe-1-6-slow" } as const;

    test("moves onto an account nothing has refused, where the provider publishes no allowance", async () => {
        expect(await offSpentAccount(devin([quota]), turn)).toEqual({
            kind: "move",
            from: "spent",
            to: "second",
            labels: { from: "radarsu@gmail.com", to: "second" },
            reason: `"radarsu@gmail.com" has used up its allowance, and "second" has not been refused`,
        });
    });

    test("stays with nowhere to go, on an account that can still serve, and for a turn naming another account", async () => {
        const everyone = DEVIN.map((account) => ({ ...quota, account: account.id }));
        expect(await offSpentAccount(devin(everyone), turn)).toEqual({ kind: "keep" });
        expect(await offSpentAccount(devin([]), turn)).toEqual({ kind: "keep" });
        expect(await offSpentAccount(devin([quota]), { ...turn, named: "spent" })).toEqual({ kind: "keep" });
    });

    test("moves a Claude conversation only onto proven room", async () => {
        const claude = (usage: Record<string, AccountUsage>): BlockedAccountDeps => ({
            ...deps(usage),
            providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", {
                onFile: async () => ({ claude: [{ ...quota, account: "home", model: undefined }] }),
            }),
        });
        const home = { ...turn, provider: "claude", remembered: "home", model: undefined } as const;
        expect(await offSpentAccount(claude({}), home)).toEqual({ kind: "keep" });
        expect(await offSpentAccount(claude({ spare: reading(20) }), home)).toMatchObject({ kind: "move", to: "spare" });
    });
});
