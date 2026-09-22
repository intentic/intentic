import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { fileUsageParkStore } from "./usage-parks.js";

// The park store is only worth having on disk, so what it owes is a deadline that survives the process that earned it.
// Path's parent directory doesn't exist yet; the store must create it on write.

const tempStore = () => {
    const path = join(mkdtempSync(join(tmpdir(), "usage-parks-")), "history", "usage-parks.json");
    return { store: fileUsageParkStore(path), path };
};

const inAnHour = (): number => Date.now() + 3_600_000;

test("read is empty when the file is absent", async () => {
    expect(await tempStore().store.read()).toEqual({});
});

test("a park survives a fresh store over the same path, which is the restart it exists for", async () => {
    const { store, path } = tempStore();
    const until = inAnHour();
    await store.record("acct-1", { provider: "claude", until });
    expect(await fileUsageParkStore(path).read()).toEqual({ "acct-1": { provider: "claude", until } });
});

test("a park whose instant has passed is not served: that account may be asked again", async () => {
    const { store } = tempStore();
    await store.record("expired", { provider: "claude", until: Date.now() - 1 });
    await store.record("standing", { provider: "codex", until: inAnHour() });
    expect(Object.keys(await store.read())).toEqual(["standing"]);
});

test("parks for several accounts sit side by side, and clearing one leaves the rest", async () => {
    const { store } = tempStore();
    await store.record("acct-1", { provider: "claude", until: inAnHour() });
    await store.record("acct-2", { provider: "claude", until: inAnHour() });
    await store.clear("acct-1");
    expect(Object.keys(await store.read())).toEqual(["acct-2"]);
    // Clearing an account with no park is a no-op, not a write.
    await store.clear("never-parked");
    expect(Object.keys(await store.read())).toEqual(["acct-2"]);
});
