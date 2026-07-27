import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountUsage, UsageWindow } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { fileClaudeUsageStore } from "./claude-usage.js";

// A store over a fresh temp path whose parent dir doesn't exist yet — the store must create it on write.
const tempStore = () => {
    const path = join(mkdtempSync(join(tmpdir(), "claude-usage-")), "history", "claude-usage.json");
    return { store: fileClaudeUsageStore(path), path };
};

const SECOND = 1000;
const inAnHour = (): number => Math.floor((Date.now() + 3600 * SECOND) / SECOND);
const window = (over: Partial<UsageWindow> = {}): UsageWindow => ({ kind: "five_hour", utilization: 42, resetsAt: inAnHour(), ...over });
const snapshot = (over: Partial<AccountUsage> = {}): AccountUsage => ({ windows: [window()], measuredAt: Date.now(), ...over });

test("read is empty when the file is absent", async () => {
    const { store } = tempStore();
    expect(await store.read()).toEqual({});
});

test("a recorded snapshot survives a fresh store over the same path", async () => {
    const { store, path } = tempStore();
    const usage = snapshot();
    await store.record("acct-1", usage);
    // A new instance = the daemon restarting (or a browser reload): the whole point is that it still knows.
    expect(await fileClaudeUsageStore(path).read()).toEqual({ "acct-1": usage });
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
    // Turns on different accounts finish whenever they finish. Overlapping whole-file writes are what the
    // store's write queue exists to prevent, so the invariant is: the file always parses, and nothing is lost.
    const ids = Array.from({ length: 12 }, (_, index) => `acct-${index}`);
    await Promise.all(ids.map((id, index) => store.record(id, snapshot({ windows: [window({ utilization: index * 8, kind: "five_hour".repeat(index + 1) })] }))));
    expect(Object.keys(JSON.parse(await readFile(path, "utf8"))).toSorted()).toEqual(ids.toSorted());
});

test("only the window that has reset is dropped — its account keeps the pools that are still live", async () => {
    const { store } = tempStore();
    const rolledOver = window({ kind: "five_hour", utilization: 99, resetsAt: Math.floor((Date.now() - 60 * SECOND) / SECOND) });
    await store.record("acct-1", snapshot({ windows: [rolledOver, window({ kind: "seven_day", utilization: 40 })] }));
    // Per-window expiry, not per-account: the weekly pool is still real when the 5-hour one rolls over, and
    // dropping the whole snapshot would blank an account's headroom five times a day.
    expect((await store.read())["acct-1"]?.windows.map((entry) => entry.kind)).toEqual(["seven_day"]);
});

test("an account left with no live window is absent, not reported as measured-and-empty", async () => {
    const { store } = tempStore();
    await store.record("fresh", snapshot());
    await store.record("rolled-over", snapshot({ windows: [window({ resetsAt: Math.floor((Date.now() - 60 * SECOND) / SECOND) })] }));
    expect(Object.keys(await store.read())).toEqual(["fresh"]);
});

test("a window with no reset instant is kept — measuredAt carries the staleness caveat instead", async () => {
    const { store } = tempStore();
    await store.record("acct-1", snapshot({ windows: [window({ resetsAt: undefined })], measuredAt: Date.now() - 5 * 24 * 3600 * SECOND }));
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
    expect(await fileClaudeUsageStore(path).read()).toEqual({});
});
