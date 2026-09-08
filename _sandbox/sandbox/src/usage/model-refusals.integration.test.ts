import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileModelRefusalStore } from "./model-refusals.js";

// Path's parent directory doesn't exist yet; the store must create it on write.
const tempStore = () => {
    const path = join(mkdtempSync(join(tmpdir(), "model-refusals-")), "history", "model-refusals.json");
    return { store: fileModelRefusalStore(path), path };
};

const HOUR = 60 * 60_000;
const REFUSED = "Your current subscription does not have access to kimi-for-coding-highspeed. Upgrade to higher-tier Kimi Code plans.";

test("nothing is refused on a sandbox that has never been refused", async () => {
    const { store } = tempStore();
    expect(await store.refused("kimi")).toEqual(new Set());
});

// Persisted since one turn's evidence must hide the row for every session after it, including tomorrow's daemon.
test("a refused model survives a fresh store over the same path", async () => {
    const { store, path } = tempStore();
    await store.record("kimi", "kimi-k2.7-code-highspeed", { at: Date.now(), message: REFUSED });
    expect(await fileModelRefusalStore(path).refused("kimi")).toEqual(new Set(["kimi-k2.7-code-highspeed"]));
});

// Filed per model, not provider: one subscription can serve some of a vendor's models and refuse others, so filing
// against the provider would hide a working model too.
test("a refusal is about the model, not the provider that published it", async () => {
    const { store } = tempStore();
    await store.record("kimi", "kimi-k2.7-code-highspeed", { at: Date.now(), message: REFUSED });
    const refused = await store.refused("kimi");
    expect(refused.has("kimi-k2.7-code-highspeed")).toBe(true);
    expect(refused.has("kimi-k3")).toBe(false);
});

// Key carries both provider and model, so one vendor's refusal doesn't hide another's identically-named row.
test("one provider's refusals are invisible to another's catalog", async () => {
    const { store } = tempStore();
    await store.record("kimi", "code-highspeed", { at: Date.now(), message: REFUSED });
    expect(await store.refused("codex")).toEqual(new Set());
});

// Forgotten after a day, since what makes a refusal true is the plan, and plans get upgraded quickly;
// provider-refusals' week-long memory would hide a model someone had just paid for.
test("forgets a refusal a plan has had a day to fix", async () => {
    const { store } = tempStore();
    await store.record("kimi", "kimi-k2.7-code-highspeed", { at: Date.now() - 25 * HOUR, message: REFUSED });
    await store.record("kimi", "kimi-k2.7-code", { at: Date.now() - 2 * HOUR, message: REFUSED });
    expect(await store.refused("kimi")).toEqual(new Set(["kimi-k2.7-code"]));
});
