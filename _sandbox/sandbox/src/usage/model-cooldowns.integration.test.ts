import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileModelCooldownStore } from "./model-cooldowns.js";

// Path's parent directory doesn't exist yet; the store must create it on write.
const tempStore = () => {
    const path = join(mkdtempSync(join(tmpdir(), "model-cooldowns-")), "history", "model-cooldowns.json");
    return { store: fileModelCooldownStore(path), path };
};

const COOLING = "All credentials for model gpt-5.6-sol are cooling down via provider codex";

test("a provider nothing has refused is cooling on nothing", async () => {
    const { store } = tempStore();
    expect(await store.cooling("codex")).toEqual(new Map());
});

// Persisted because the point is to stop the NEXT page load offering a model the daemon already knows is refused,
// including after a restart.
test("a cooldown survives a fresh store over the same path", async () => {
    const { store, path } = tempStore();
    const until = Date.now() + 300_000;
    await store.record("codex", "gpt-5.6-sol", { until, message: COOLING });
    expect(await fileModelCooldownStore(path).cooling("codex")).toEqual(new Map([["gpt-5.6-sol", { until, message: COOLING }]]));
});

// The whole reason this is keyed by model: the fleet refused one model, and the sibling it serves fine must stay
// offered. A per-provider bench is what made "any GPT model hits the limit" look true when only the flagship did.
test("one model's cooldown says nothing about the provider's others", async () => {
    const { store } = tempStore();
    await store.record("codex", "gpt-5.6-sol", { until: Date.now() + 300_000, message: COOLING });
    expect([...(await store.cooling("codex")).keys()]).toEqual(["gpt-5.6-sol"]);
});

// Model ids are not unique across providers, and the catalog is asked per provider.
test("a cooldown answers only for the provider it was filed under", async () => {
    const { store } = tempStore();
    await store.record("codex", "gpt-5.6-sol", { until: Date.now() + 300_000, message: COOLING });
    expect(await store.cooling("cursor")).toEqual(new Map());
});

// Nothing has to run for a cooldown to end: the instant passing is the whole of it.
test("a cooldown whose instant has passed is gone without anything clearing it", async () => {
    const { store } = tempStore();
    await store.record("codex", "gpt-5.6-sol", { until: Date.now() - 1, message: COOLING });
    expect(await store.cooling("codex")).toEqual(new Map());
});
