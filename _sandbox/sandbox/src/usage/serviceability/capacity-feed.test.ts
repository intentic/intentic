import type { AccountUsage, ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { ProviderCapacity } from "@intentic/sandbox-contract/schemas/providers/capacity";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import type { Services } from "../../composition.js";
import { recordingLogger } from "../../harness/route-fakes.testing.js";
import { capacitySnapshot, onCapacity, provideCapacityPorts, providerCapacity, type CapacityFeedDeps } from "./capacity-feed.js";
import { type CapacityWatchDeps, nudgeCapacity, watchCapacity } from "./capacity-watch.js";
import { providerDegraded, recordProviderFailure, recordProviderSuccess } from "../../agent/providers/provider-health.js";

// Two Claude accounts: one read with room, one read full in a five-hour window that resets soon, with the provider's
// refusal on file for it.
const now = Date.now();
const soon = Math.floor(now / 1000) + 1;
const later = Math.floor(now / 1000) + 86_400;
const reading = (fiveHour: number, resetsAt: number): AccountUsage => ({
    measuredAt: now - 30_000,
    windows: [
        { kind: "five_hour", utilization: fiveHour, resetsAt, gates: "all" },
        { kind: "seven_day", utilization: 20, resetsAt: later, gates: "all" },
    ],
});
const refused: ProviderRefusal = { at: now - 20_000, kind: "limit", account: "b", message: "You've hit your limit", resetsAt: soon };

const deps = (over: Partial<CapacityFeedDeps> = {}): CapacityFeedDeps =>
    unstubbed<CapacityFeedDeps>("deps", {
        claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", {
            list: async () => [
                { id: "a", label: "Work", connectedAt: 0 },
                { id: "b", label: "Home", connectedAt: 0 },
            ],
        }),
        claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => ({}) }),
        accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => ({ a: reading(40, later), b: reading(100, soon) }) }),
        providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", {
            onFile: async () => ({ claude: [refused] }),
            switchOffs: async () => ({}),
            onChange: () => () => undefined,
        }),
        ...over,
    });

test("a provider's capacity is every fact judged, each verdict, where an unnamed turn runs and when the clock changes it", async () => {
    const capacity = await providerCapacity(deps(), "claude", now, { placementOf: async () => "a", degradedOf: () => undefined });
    expect(capacity.accounts.map(({ account, label, state }) => ({ account, label, state }))).toEqual([
        { account: "a", label: "Work", state: { kind: "ready", room: 60, renewsAt: later } },
        { account: "b", label: "Home", state: { kind: "spent", reopensAt: soon } },
    ]);
    expect(capacity).toMatchObject({ provider: "claude", judgedAt: now, refusals: [refused], placement: "a", validUntil: soon * 1000 });
    expect(capacity.degraded).toBeUndefined();
    // Judged again past the reset, the window and the refusal are both over.
    const after = await providerCapacity(deps(), "claude", soon * 1000 + 1, {});
    expect(after.accounts.map((account) => account.state)).toEqual([
        { kind: "ready", room: 60, renewsAt: later },
        { kind: "ready", room: 80, renewsAt: later },
    ]);
    expect(after.seq).toBeGreaterThan(capacity.seq);
    expect(after.validUntil).toBe(later * 1000);
});

test("a provider failing turns says so, and is judged again when it is next tried", async () => {
    const retryAt = now + 30_000;
    const capacity = await providerCapacity(
        deps({
            accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => ({}) }),
            providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => ({}), switchOffs: async () => ({}) }),
        }),
        "claude",
        now,
        { degradedOf: () => ({ cause: "outage", retryAt, attempt: 1 }) },
    );
    expect(capacity.degraded).toEqual({ cause: "outage", retryAt, attempt: 1 });
    expect(capacity.validUntil).toBe(retryAt);
});

test("the snapshot holds every provider with an account or a refusal on file, and none without", async () => {
    const undo = provideCapacityPorts({ placementOf: async (provider) => (provider === "claude" ? "a" : undefined) });
    try {
        const snapshot = await capacitySnapshot(
            deps({
                providerAccounts: async () => [],
                cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", { accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [] }) }),
            }),
            now,
        );
        expect(snapshot.providers.map((capacity) => [capacity.provider, capacity.placement])).toEqual([["claude", "a"]]);
    } finally {
        undo();
    }
});

test("a window that listens hears a provider's capacity on every change and again when the clock alone changes it", async () => {
    const heard: ProviderCapacity[] = [];
    // Two seconds out from now, so the first judgement (half a second after the nudge) still reads it spent.
    const reopen = Math.ceil(Date.now() / 1000) + 2;
    const watching: CapacityWatchDeps = {
        ...deps({
            accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => ({ a: reading(40, later), b: reading(100, reopen) }) }),
            providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", {
                onFile: async () => ({ claude: [{ ...refused, resetsAt: reopen }] }),
                switchOffs: async () => ({}),
                onChange: () => () => undefined,
            }),
        }),
        headroom: unstubbed<Services["headroom"]>("headroom", { onChange: () => () => undefined, refresh: async () => undefined }),
        logger: recordingLogger().logger,
    };
    const unhear = onCapacity((capacity) => heard.push(capacity));
    const stop = watchCapacity(watching);
    try {
        nudgeCapacity("claude");
        await waitFor(() => expect(heard.map((capacity) => capacity.accounts[1]?.state.kind)).toEqual(["spent"]), { timeout: 3_000, interval: 20 });
        // Its `validUntil` is the refusal's instant: the watch judges it again then, unasked.
        await waitFor(() => expect(heard.map((capacity) => capacity.accounts[1]?.state.kind)).toContain("ready"), { timeout: 6_000, interval: 50 });
    } finally {
        stop();
        unhear();
    }
});

// The breaker in memory (provider-health.ts) tells the capacity whether its wait was opened by a throttle or an outage,
// and every change of it reaches a listening window without anything else moving (2026-11-19).
test("a provider's throttle reaches a listening window as one, and its end as nothing failing", async () => {
    const heard: ProviderCapacity[] = [];
    const watching: CapacityWatchDeps = {
        ...deps(),
        headroom: unstubbed<Services["headroom"]>("headroom", { onChange: () => () => undefined, refresh: async () => undefined }),
        logger: recordingLogger().logger,
    };
    const undo = provideCapacityPorts({ degradedOf: providerDegraded });
    const unhear = onCapacity((capacity) => heard.push(capacity));
    const stop = watchCapacity(watching);
    try {
        const { retryAt } = recordProviderFailure("claude", Date.now(), "throttle");
        await waitFor(() => expect(heard.at(-1)?.degraded).toEqual({ cause: "throttle", retryAt, attempt: 0 }), { timeout: 3_000, interval: 20 });
        recordProviderSuccess("claude");
        await waitFor(() => expect(heard.at(-1)?.degraded).toBeUndefined(), { timeout: 3_000, interval: 20 });
    } finally {
        recordProviderSuccess("claude");
        stop();
        unhear();
        undo();
    }
});
