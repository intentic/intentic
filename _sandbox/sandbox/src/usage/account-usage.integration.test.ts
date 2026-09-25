import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountUsage, UsageWindow } from "@intentic/sandbox-contract";
import { accountLimitReset, fileAccountUsageStore } from "./account-usage.js";

// Path's parent directory doesn't exist yet; the store must create it on write.
const tempStore = () => {
    const path = join(mkdtempSync(join(tmpdir(), "account-usage-")), "history", "account-usage.json");
    return { store: fileAccountUsageStore(path), path };
};

const SECOND = 1000;
// Anchored once per file: two live reads of "an hour from now" could straddle a second and differ by one.
const NOW = Date.now();
const inAnHour = (): number => Math.floor((NOW + 3600 * SECOND) / SECOND);
const window = (over: Partial<UsageWindow> = {}): UsageWindow => ({
    kind: "five_hour",
    utilization: 42,
    resetsAt: inAnHour(),
    gates: "all",
    ...over,
});
const snapshot = (over: Partial<AccountUsage> = {}): AccountUsage => ({ windows: [window()], measuredAt: Date.now(), ...over });

test("read is empty when the file is absent", async () => {
    const { store } = tempStore();
    expect(await store.read()).toEqual({});
});

test("a recorded snapshot survives a fresh store over the same path", async () => {
    const { store, path } = tempStore();
    const usage = snapshot();
    await store.record("acct-1", usage);
    // A new instance models the daemon restarting, or a browser reload.
    expect(await fileAccountUsageStore(path).read()).toEqual({ "acct-1": usage });
});

test("snapshots for several accounts are kept side by side", async () => {
    const { store } = tempStore();
    await store.record("acct-1", snapshot({ windows: [window({ utilization: 10 })] }));
    await store.record("acct-2", snapshot({ windows: [window({ utilization: 90 })] }));
    const read = await store.read();
    expect(read["acct-1"]?.windows[0]?.utilization).toBe(10);
    expect(read["acct-2"]?.windows[0]?.utilization).toBe(90);
});

test("concurrent records leave a parseable file holding every account", async () => {
    const { store, path } = tempStore();
    // Turns on different accounts finish independently; the write queue keeps the file parseable regardless.
    const ids = Array.from({ length: 12 }, (_, index) => `acct-${index}`);
    await Promise.all(
        ids.map((id, index) => store.record(id, snapshot({ windows: [window({ utilization: index * 8, kind: "five_hour".repeat(index + 1) })] }))),
    );
    expect(Object.keys(JSON.parse(await readFile(path, "utf8"))).toSorted()).toEqual(ids.toSorted());
});

test("only the window that has reset is dropped: its account keeps the pools that are still live", async () => {
    const { store } = tempStore();
    const rolledOver = window({ kind: "five_hour", utilization: 99, resetsAt: Math.floor((Date.now() - 60 * SECOND) / SECOND) });
    await store.record("acct-1", snapshot({ windows: [rolledOver, window({ kind: "seven_day", utilization: 40 })] }));
    expect((await store.read())["acct-1"]?.windows.map((entry) => entry.kind)).toEqual(["seven_day"]);
});

test("an account left with no live window is absent, not reported as measured-and-empty", async () => {
    const { store } = tempStore();
    await store.record("fresh", snapshot());
    await store.record("rolled-over", snapshot({ windows: [window({ resetsAt: Math.floor((Date.now() - 60 * SECOND) / SECOND) })] }));
    expect(Object.keys(await store.read())).toEqual(["fresh"]);
});

// A five-hour pool nothing has spent yet is published with no reset instant at all, so retiring windows by that instant
// alone left the one reading most likely to go wrong as the only one nothing could ever retire. An idle 0% read at
// breakfast still said 0% at midnight, under a provider that had been refusing re-reads all day.
test("a window with no reset instant is retired by its own length", async () => {
    const { store } = tempStore();
    const idle = (agoMs: number): AccountUsage =>
        snapshot({ windows: [window({ utilization: 0, resetsAt: undefined })], measuredAt: Date.now() - agoMs });

    // Inside the five hours it describes, the reading can still be true, and measuredAt carries the staleness caveat.
    await store.record("acct-1", idle(4 * 3600 * SECOND));
    expect(Object.keys(await store.read())).toEqual(["acct-1"]);

    // Past them a whole window has opened and closed since, so the figure describes nothing. An account left with no
    // live window is absent, which every reader takes as "no reading" rather than "no limits".
    await store.record("acct-1", idle(6 * 3600 * SECOND));
    expect(await store.read()).toEqual({});
});

test("a window whose length nothing names still rests on its reset instant alone", async () => {
    const { store } = tempStore();
    // Neither the provider's key nor its name says how long this runs, so there is nothing to retire it by but a reset.
    const unnamed = window({ kind: "claude:tangelo", resetsAt: undefined });
    await store.record("acct-1", snapshot({ windows: [unnamed], measuredAt: Date.now() - 5 * 24 * 3600 * SECOND }));
    expect(Object.keys(await store.read())).toEqual(["acct-1"]);
});

test("clear forgets one account's snapshot and leaves the rest", async () => {
    const { store } = tempStore();
    await store.record("acct-1", snapshot());
    await store.record("acct-2", snapshot());
    await store.clear("acct-1");
    expect(Object.keys(await store.read())).toEqual(["acct-2"]);
});

test("a half-written or foreign file degrades to empty instead of throwing", async () => {
    const { store, path } = tempStore();
    await store.record("acct-1", snapshot());
    await writeFile(path, "{ not json");
    expect(await fileAccountUsageStore(path).read()).toEqual({});
});

test("accountLimitReset answers with the fullest pool's reset, the one that refused the turn", async () => {
    const { store } = tempStore();
    await store.record("acct-1", {
        measuredAt: Date.now(),
        windows: [window({ utilization: 40, resetsAt: inAnHour() }), window({ kind: "seven_day", utilization: 98, resetsAt: inAnHour() + 900 })],
    });
    expect(await accountLimitReset(store, "acct-1", undefined)).toBe(inAnHour() + 900);
    expect(await accountLimitReset(store, "acct-unknown", undefined)).toBeUndefined();
    expect(await accountLimitReset(store, undefined, undefined)).toBeUndefined();
});

test("accountLimitReset names the reset of the pool the refused MODEL spends, not the account's fullest", async () => {
    // Opus reopens far off, the weekly pool the refused Sonnet turn spends reopens soon: naming Opus's reset would send
    // the user away for days.
    const { store } = tempStore();
    await store.record("acct-1", {
        measuredAt: Date.now(),
        windows: [
            window({ kind: "seven_day", utilization: 90, resetsAt: inAnHour() }),
            window({ kind: "model:Opus", label: "Opus", utilization: 100, resetsAt: inAnHour() + 86_400, gates: { models: ["Opus"] } }),
        ],
    });
    expect(await accountLimitReset(store, "acct-1", { id: "claude-sonnet-4-6" })).toBe(inAnHour());
    expect(await accountLimitReset(store, "acct-1", { id: "claude-opus-4-6" })).toBe(inAnHour() + 86_400);
});
