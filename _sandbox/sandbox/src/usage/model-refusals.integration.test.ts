import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileModelRefusalStore } from "./model-refusals.js";

// A store over a fresh temp path whose parent dir doesn't exist yet: the store must create it on write.
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

// The reason this is a file rather than a variable: the evidence is one turn, and the picker has to keep the
// row hidden for every session after it, including the ones in tomorrow's daemon.
test("a refused model survives a fresh store over the same path", async () => {
    const { store, path } = tempStore();
    await store.record("kimi", "kimi-k2.7-code-highspeed", { at: Date.now(), message: REFUSED });
    expect(await fileModelRefusalStore(path).refused("kimi")).toEqual(new Set(["kimi-k2.7-code-highspeed"]));
});

/* THE WHOLE REASON THIS IS NOT provider-refusals: one subscription serves some of a vendor's models and not
 * others, so a refusal is about the pair. Filing it against the provider would take K3 — which answers in a
 * second on the very same credential — off the picker along with the model that was actually refused. */
test("a refusal is about the model, not the provider that published it", async () => {
    const { store } = tempStore();
    await store.record("kimi", "kimi-k2.7-code-highspeed", { at: Date.now(), message: REFUSED });
    const refused = await store.refused("kimi");
    expect(refused.has("kimi-k2.7-code-highspeed")).toBe(true);
    expect(refused.has("kimi-k3")).toBe(false);
});

// …and not about another vendor's identically-named row either, which is why the key carries both.
test("one provider's refusals are invisible to another's catalog", async () => {
    const { store } = tempStore();
    await store.record("kimi", "code-highspeed", { at: Date.now(), message: REFUSED });
    expect(await store.refused("codex")).toEqual(new Set());
});

/* FORGOTTEN AFTER A DAY, and the number is the argument: what makes this refusal true is the PLAN, and plans
 * get upgraded — often within minutes of reading a refusal that names the tier. A week (what provider-refusals
 * keeps) would hide a model somebody had just paid for, with nothing on screen to say where it went. */
test("forgets a refusal a plan has had a day to fix", async () => {
    const { store } = tempStore();
    await store.record("kimi", "kimi-k2.7-code-highspeed", { at: Date.now() - 25 * HOUR, message: REFUSED });
    await store.record("kimi", "kimi-k2.7-code", { at: Date.now() - 2 * HOUR, message: REFUSED });
    expect(await store.refused("kimi")).toEqual(new Set(["kimi-k2.7-code"]));
});
