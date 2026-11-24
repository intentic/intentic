import { createHash } from "node:crypto";
import type { PoolSignal } from "@intentic/api-contract/ingress";
import type { ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { memoryProviderRefusalStore } from "../../../usage/provider-refusals.js";
import {
    claudeFingerprint,
    type HeldAccount,
    hearPoolSignals,
    type PoolSignalDeps,
    poolFingerprint,
    routedFingerprint,
    sharingRunOuts,
} from "./pool-signals.js";

// Run-outs shared across sandboxes, the daemon's half: a spent allowance met here is told under the account's
// fingerprint, keyed by the owner's pool key, and one another sandbox met on an account held here is filed on the ledger
// as heard, until a turn answered here proves it over. With no key, nothing is told and nothing asked.

const NOW = Date.parse("2026-11-24T12:00:00Z");
// Two owners' pool keys, as the platform mints them: 32 bytes in hex.
const ADA_KEY = "a1".repeat(32);
const BOB_KEY = "b2".repeat(32);
const FP = poolFingerprint(ADA_KEY, "claude", ["acct-1", "org-1"]) ?? "";
// The one account held here, fingerprinted under whichever key the platform handed over.
const heldUnder = async (key: string): Promise<HeldAccount[]> => [
    { provider: "claude", account: "local-1", fingerprint: poolFingerprint(key, "claude", ["acct-1", "org-1"]) ?? "" },
];

// `null` is a sandbox the platform handed no key (an older platform, or one not reached).
const depsWith = (signals: readonly PoolSignal[] = [], key: string | null = ADA_KEY) => {
    const told: PoolSignal[] = [];
    const asked: (readonly string[])[] = [];
    let heardTold: (() => void) | undefined;
    const tellings = new Promise<void>((resolve) => {
        heardTold = resolve;
    });
    const deps: PoolSignalDeps = {
        held: heldUnder,
        platform: {
            key: async () => key ?? undefined,
            report: async (signal) => {
                told.push(signal);
                heardTold?.();
            },
            read: async (fingerprints) => {
                asked.push(fingerprints);
                return signals;
            },
        },
        log: () => undefined,
    };
    return { deps, told, asked, tellings };
};

const limit = (fields: Partial<ProviderRefusal> = {}): ProviderRefusal => ({
    at: NOW - 1000,
    kind: "limit",
    message: "usage limit",
    account: "local-1",
    ...fields,
});

describe("telling the owner's other sandboxes", () => {
    it("tells a spent allowance on a held account under its fingerprint, with the provider's reset", async () => {
        const { deps, told, tellings } = depsWith();
        const store = sharingRunOuts(memoryProviderRefusalStore(), () => deps);
        await store.record("claude", limit({ resetsAt: 1_900_000_000 }));
        await tellings;
        expect(told).toEqual([{ fingerprint: FP, pool: "*", ranOutAt: NOW - 1000, resetsAt: 1_900_000_000 }]);
    });

    it("tells nothing of a heard run-out, a mark by hand, a refused sign-in, or an account with no fingerprint", async () => {
        const { deps, told } = depsWith();
        const store = sharingRunOuts(memoryProviderRefusalStore(), () => deps);
        await store.record("claude", limit({ source: "another-sandbox" }));
        await store.record("claude", limit({ byHand: true, at: NOW - 500 }));
        await store.record("claude", limit({ kind: "auth" }));
        await store.record("claude", limit({ account: "unfingerprinted", at: NOW - 400 }));
        // The last one is looked up and dropped asynchronously; give it the turn it needs.
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(told).toEqual([]);
    });

    it("tells nothing and asks nothing without the owner's key", async () => {
        const signal: PoolSignal = { fingerprint: FP, pool: "*", ranOutAt: NOW - 60_000 };
        const { deps, told, asked } = depsWith([signal], null);
        const store = sharingRunOuts(memoryProviderRefusalStore(), () => deps);
        await store.record("claude", limit());
        // The lookup that drops it runs asynchronously; give it the turn it needs.
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(told).toEqual([]);
        expect(await hearPoolSignals(store, deps, new Set(), NOW)).toBe(0);
        expect(asked).toEqual([]);
    });
});

describe("hearing them", () => {
    const signal: PoolSignal = { fingerprint: FP, pool: "five_hour", ranOutAt: NOW - 60_000, resetsAt: Math.floor(NOW / 1000) + 3600 };

    it("files a live run-out on the account that fingerprint names, as seen in another sandbox", async () => {
        const { deps } = depsWith([signal]);
        const store = memoryProviderRefusalStore();
        expect(await hearPoolSignals(store, deps, new Set(), NOW)).toBe(1);
        expect((await store.onFile())["claude"]).toEqual([
            {
                at: NOW - 60_000,
                kind: "limit",
                message: expect.stringContaining("another sandbox"),
                account: "local-1",
                source: "another-sandbox",
                resetsAt: signal.resetsAt,
                pool: "five_hour",
            },
        ]);
    });

    it("ignores a fingerprint nothing here holds, and a run-out already past its reset", async () => {
        const stranger = { ...signal, fingerprint: "c".repeat(64) };
        const over = { ...signal, resetsAt: Math.floor(NOW / 1000) - 1 };
        const { deps } = depsWith([stranger, over]);
        const store = memoryProviderRefusalStore();
        expect(await hearPoolSignals(store, deps, new Set(), NOW)).toBe(0);
        expect(await store.onFile()).toEqual({});
    });

    it("lets a turn answered here clear it, and does not file the same run-out again", async () => {
        const { deps } = depsWith([signal]);
        const store = memoryProviderRefusalStore();
        const heard = new Set<string>();
        await hearPoolSignals(store, deps, heard, NOW);
        await store.settle("claude", { account: "local-1", model: "opus", askedAt: NOW });
        expect(await store.onFile()).toEqual({});
        expect(await hearPoolSignals(store, deps, heard, NOW)).toBe(0);
        expect(await store.onFile()).toEqual({});
    });
});

describe("fingerprints", () => {
    it("hashes a Claude seat only with both its uuids, and never carries them", () => {
        expect(claudeFingerprint(ADA_KEY, { accountUuid: "acct-1" })).toBeUndefined();
        const fingerprint = claudeFingerprint(ADA_KEY, { accountUuid: "acct-1", organizationUuid: "org-1" });
        expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(fingerprint).not.toContain("acct-1");
        expect(claudeFingerprint(ADA_KEY, { accountUuid: "acct-2", organizationUuid: "org-1" })).not.toBe(fingerprint);
    });

    it("names one seat held by two owners as two unrelated values, and neither is the unkeyed hash", () => {
        const seat = { accountUuid: "acct-1", organizationUuid: "org-1" };
        expect(claudeFingerprint(ADA_KEY, seat)).toBe(claudeFingerprint(ADA_KEY, seat));
        expect(claudeFingerprint(ADA_KEY, seat)).not.toBe(claudeFingerprint(BOB_KEY, seat));
        const google = { email: "ada@example.com", project_id: "p-1" };
        expect(routedFingerprint(ADA_KEY, "gemini", google)).not.toBe(routedFingerprint(BOB_KEY, "gemini", google));
        const unkeyed = createHash("sha256").update(["claude", "acct-1", "org-1"].join("\0")).digest("hex");
        expect([claudeFingerprint(ADA_KEY, seat), claudeFingerprint(BOB_KEY, seat)]).not.toContain(unkeyed);
    });

    it("reads a Codex seat's account and user off its OpenID token, as a JWT or parsed", () => {
        const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "ws-1", chatgpt_user_id: "user-1" } };
        const jwt = `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
        const fromJwt = routedFingerprint(ADA_KEY, "codex", { id_token: jwt });
        expect(fromJwt).toBe(poolFingerprint(ADA_KEY, "codex", ["ws-1", "user-1"]));
        expect(routedFingerprint(ADA_KEY, "codex", { id_token: claims })).toBe(fromJwt);
        // A workspace's id alone names every seat in it, so it makes no fingerprint.
        expect(routedFingerprint(ADA_KEY, "codex", { id_token: { chatgpt_account_id: "ws-1" } })).toBeUndefined();
    });

    it("names a Google account by its email and project, and makes none for Kimi", () => {
        expect(routedFingerprint(ADA_KEY, "gemini", { email: "Ada@Example.com", project_id: "p-1" })).toBe(
            poolFingerprint(ADA_KEY, "gemini", ["ada@example.com", "p-1"]),
        );
        expect(routedFingerprint(ADA_KEY, "gemini", { email: "ada@example.com" })).toBeUndefined();
        expect(routedFingerprint(ADA_KEY, "kimi", { email: "ada@example.com" })).toBeUndefined();
    });
});
