import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileObservedLimitStore, OBSERVED_FOR_MS } from "./observed-limits.js";

// Path's parent directory doesn't exist yet; the store must create it on write.
const tempStore = () => {
    const path = join(mkdtempSync(join(tmpdir(), "observed-limits-")), "history", "observed-limits.json");
    return { store: fileObservedLimitStore(path), path };
};

const REFUSED = "429 You've hit your usage limit for this model.";

test("an account nobody has been refused on is out of nothing", async () => {
    const { store } = tempStore();
    expect(await store.spent("cursor", "one")).toEqual({});
});

// Persisted because the point is to stop the NEXT turn asking the account that just said no, including tomorrow's.
test("a refusal survives a fresh store over the same path", async () => {
    const { store, path } = tempStore();
    await store.record("cursor", "one", "composer-2.5", { at: Date.now(), message: REFUSED });
    expect(Object.keys(await fileObservedLimitStore(path).spent("cursor", "one"))).toEqual(["composer-2.5"]);
});

// The whole reason this is keyed by account: a plan is spent per credential, and the fleet's other one is untouched.
test("one account's spent model says nothing about the sibling's", async () => {
    const { store } = tempStore();
    await store.record("cursor", "one", "composer-2.5", { at: Date.now(), message: REFUSED });
    expect(await store.spent("cursor", "two")).toEqual({});
});

test("an account can be out of two models at once, and a second refusal keeps the first", async () => {
    const { store } = tempStore();
    await store.record("cursor", "one", "claude-opus-5", { at: Date.now(), message: REFUSED });
    await store.record("cursor", "one", "composer-2.5", { at: Date.now(), message: REFUSED });
    expect(Object.keys(await store.spent("cursor", "one")).toSorted()).toEqual(["claude-opus-5", "composer-2.5"]);
});

// Forgotten on its own, since nothing else ever will: the vendor publishes no reset, so only this horizon reopens it.
test("forgets a refusal it has believed for its whole horizon", async () => {
    const { store } = tempStore();
    const now = Date.now();
    await store.record("cursor", "one", "claude-opus-5", { at: now - OBSERVED_FOR_MS - 1000, message: REFUSED });
    await store.record("cursor", "one", "composer-2.5", { at: now - 1000, message: REFUSED });
    expect(Object.keys(await store.spent("cursor", "one"))).toEqual(["composer-2.5"]);
});
