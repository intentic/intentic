import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountUsage, UsageWindow } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { accountLimitReset, accountWithHeadroom, fileAccountUsageStore } from "./account-usage.js";

// A store over a fresh temp path whose parent dir doesn't exist yet: the store must create it on write.
const tempStore = () => {
    const path = join(mkdtempSync(join(tmpdir(), "account-usage-")), "history", "account-usage.json");
    return { store: fileAccountUsageStore(path), path };
};

const SECOND = 1000;
// Anchored to one instant for the whole file: read off the wall clock at each call site, two reads of "an hour
// from now" that straddle a second boundary differ by one, and an assertion comparing a stored reset to a
// freshly computed one fails for no reason at all.
const NOW = Date.now();
const inAnHour = (): number => Math.floor((NOW + 3600 * SECOND) / SECOND);
const window = (over: Partial<UsageWindow> = {}): UsageWindow => ({ kind: "five_hour", utilization: 42, resetsAt: inAnHour(), gates: "all", ...over });
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
    // Turns on different accounts finish whenever they finish. Overlapping whole-file writes are what the
    // store's write queue exists to prevent, so the invariant is: the file always parses, and nothing is lost.
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

test("a window with no reset instant is kept: measuredAt carries the staleness caveat instead", async () => {
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
    // A plan that meters Opus on its own: the Opus slice is full and reopens on Sunday, the weekly pool the
    // refused Sonnet turn actually spends is the tightest one it has and reopens in an hour. Naming Sunday
    // would send the user away for days.
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

test("ranks accounts on the pools the turn's model spends: a spent Opus slice does not bench an account for Haiku", async () => {
    const { store } = tempStore();
    await store.record("opus-spent", {
        measuredAt: Date.now(),
        windows: [window({ kind: "seven_day", utilization: 10 }), window({ kind: "model:Opus", utilization: 100, gates: { models: ["Opus"] } })],
    });
    await store.record("steady", { measuredAt: Date.now(), windows: [window({ kind: "seven_day", utilization: 60 })] });
    expect(await accountWithHeadroom(store, ["steady", "opus-spent"], undefined, { id: "claude-haiku-4-5" })).toBe("opus-spent");
    expect(await accountWithHeadroom(store, ["steady", "opus-spent"], undefined, { id: "claude-opus-4-6" })).toBe("steady");
    // With no model named, every pool that gates anything counts, and the Opus slice benches its account.
    expect(await accountWithHeadroom(store, ["steady", "opus-spent"])).toBe("steady");
});

/* WHICH ACCOUNT AN UNNAMED CALLER RUNS ON. The rule this replaced was "the oldest-connected one, forever",
 * which is how one spent account came to absorb every helper call in the sandbox while two others sat with
 * room, and why no session title had ever been written. */

test("prefers the account with the most room left", async () => {
    const { store } = tempStore();
    await store.record("busy", { measuredAt: Date.now(), windows: [window({ utilization: 92 })] });
    await store.record("free", { measuredAt: Date.now(), windows: [window({ utilization: 18 })] });
    expect(await accountWithHeadroom(store, ["busy", "free"])).toBe("free");
});

test("reads an account at its WORST pool, not its kindest", async () => {
    // Five-hour room is no use to a turn its weekly window will refuse.
    const { store } = tempStore();
    await store.record("weekly-spent", {
        measuredAt: Date.now(),
        windows: [window({ utilization: 4 }), window({ kind: "seven_day", utilization: 100 })],
    });
    await store.record("steady", { measuredAt: Date.now(), windows: [window({ utilization: 60 })] });
    expect(await accountWithHeadroom(store, ["weekly-spent", "steady"])).toBe("steady");
});

test("ranks a never-measured account below a proven one, and a spent one below that", async () => {
    /* The three tiers, in the order that matters. An account nothing has measured is exactly how one goes spent
     * unnoticed: it is listed first by connectedAt and never appears in the usage file at all, so it must not
     * outrank an account known to have room. It must still beat one known to be at the cap. */
    const { store } = tempStore();
    await store.record("proven", { measuredAt: Date.now(), windows: [window({ utilization: 70 })] });
    await store.record("capped", { measuredAt: Date.now(), windows: [window({ utilization: 100 })] });
    expect(await accountWithHeadroom(store, ["unmeasured", "proven", "capped"])).toBe("proven");
    expect(await accountWithHeadroom(store, ["capped", "unmeasured"])).toBe("unmeasured");
});

test("keeps the caller's order between equals, so the pick does not flap", async () => {
    // Ties resolve to connectedAt (the order the store hands over) rather than rotating between accounts and
    // fragmenting attribution across them.
    const { store } = tempStore();
    await store.record("first", { measuredAt: Date.now(), windows: [window({ utilization: 50 })] });
    await store.record("second", { measuredAt: Date.now(), windows: [window({ utilization: 50 })] });
    expect(await accountWithHeadroom(store, ["first", "second"])).toBe("first");
    expect(await accountWithHeadroom(store, ["second", "first"])).toBe("second");
});

test("a window the provider has already reset stops counting against an account", async () => {
    /* read() drops expired windows, and an account left with none is absent rather than measured-and-empty, so
     * a stale 100% no longer benches its account: it leaves the capped tier and reads as unmeasured, which is
     * enough to be picked ahead of one still at its cap. It does NOT leapfrog an account proven to have room,
     * because "reset, therefore free" and "never measured" arrive here as the same fact and only one of them is
     * safe to bet on. */
    const { store } = tempStore();
    await store.record("reset", { measuredAt: Date.now(), windows: [window({ utilization: 100, resetsAt: 1 })] });
    await store.record("capped", { measuredAt: Date.now(), windows: [window({ utilization: 100 })] });
    await store.record("proven", { measuredAt: Date.now(), windows: [window({ utilization: 80 })] });
    expect(await accountWithHeadroom(store, ["capped", "reset"])).toBe("reset");
    expect(await accountWithHeadroom(store, ["reset", "proven"])).toBe("proven");
});

test("one account, or none, needs no reading at all", async () => {
    const { store } = tempStore();
    expect(await accountWithHeadroom(store, ["only"])).toBe("only");
    expect(await accountWithHeadroom(store, [])).toBeUndefined();
});

/* THE TRAP THE METER CANNOT SEE. An account the provider refuses outright: an organization with Claude Code
 * switched off: never gets to spend anything, so its utilization freezes while every working account's climbs.
 * Read on headroom alone it therefore looks like the freshest account in the sandbox, wins every unnamed pick,
 * and dies on the same 403 each time: twenty unattended runs went that way in one evening before this tier
 * existed. Being refused has to outrank looking untouched. */
test("passes over the account the provider has refused, however good its meter looks", async () => {
    const { store } = tempStore();
    await store.record("refused", { measuredAt: Date.now(), windows: [window({ utilization: 2 })] });
    await store.record("working", { measuredAt: Date.now(), windows: [window({ utilization: 88 })] });
    expect(await accountWithHeadroom(store, ["refused", "working"], "refused")).toBe("working");
    // Named nobody ⇒ ranked as before, which is the whole of what a sandbox with nothing refused should see.
    expect(await accountWithHeadroom(store, ["refused", "working"])).toBe("refused");
});

test("still runs the only account there is, refused or not", async () => {
    // Nothing to fall back to, and a refusal on file may be a week old, so the turn goes, and its failure now
    // says why (agents-registry's `failure`) instead of the sandbox refusing on the strength of old news.
    const { store } = tempStore();
    await store.record("only", { measuredAt: Date.now(), windows: [window({ utilization: 5 })] });
    expect(await accountWithHeadroom(store, ["only"], "only")).toBe("only");
});
