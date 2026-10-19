import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// A model that just served a turn is open, whatever instant was stored: the row must stop reading "Back at …".
test("a cleared cooldown is gone, and its siblings stay benched", async () => {
    const { store } = tempStore();
    const until = Date.now() + 300_000;
    await store.record("codex", "gpt-6-astra", { until, message: COOLING });
    await store.record("codex", "gpt-5.6-sol", { until, message: COOLING });
    await store.clear("codex", "gpt-6-astra");
    expect([...(await store.cooling("codex")).keys()]).toEqual(["gpt-5.6-sol"]);
});

// Benched while the answering request was in flight: that answer says nothing about the bench (provider-refusals.ts).
test("an answer to a request sent before the bench leaves it standing, and one sent after reopens it", async () => {
    const { store } = tempStore();
    const until = Date.now() + 300_000;
    await store.record("codex", "gpt-6.1-sol", { until, message: COOLING, since: 13_000 });
    await store.clear("codex", "gpt-6.1-sol", 9_000);
    expect((await store.cooling("codex")).get("gpt-6.1-sol")?.until).toBe(until);

    await store.clear("codex", "gpt-6.1-sol", 13_001);
    expect(await store.cooling("codex")).toEqual(new Map());
});

// An older build wrote no `since`; any answer settles such an entry, as every answer did then.
test("a bench with no filing instant is settled by any answer", async () => {
    const { store } = tempStore();
    await store.record("codex", "gpt-6.1-sol", { until: Date.now() + 300_000, message: COOLING });
    await store.clear("codex", "gpt-6.1-sol", 9_000);
    expect(await store.cooling("codex")).toEqual(new Map());
});

// The common case is a turn on a model nothing benched; clearing it must not create the file.
test("clearing a model nothing benched writes nothing", async () => {
    const { store, path } = tempStore();
    await store.clear("codex", "gpt-6-astra");
    expect(existsSync(path)).toBe(false);
});

// A cooldown recorded and never cleared reads, from outside, as a model that vanished: both ends are logged.
test("logs a model benched and reopened, and stays quiet on a clear with nothing stored", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "model-cooldowns-")), "history", "model-cooldowns.json");
    const lines: { fields: Record<string, unknown>; message: string }[] = [];
    const store = fileModelCooldownStore(path, { log: (fields, message) => lines.push({ fields, message }) });
    await store.clear("codex", "gpt-5.6-sol");
    await store.record("codex", "gpt-5.6-sol", { until: Date.now() + 300_000, message: COOLING });
    await store.clear("codex", "gpt-5.6-sol");
    expect(lines.map((line) => line.message.replace(/until \S+/u, "until <at>"))).toEqual([
        "model cooldown: codex gpt-5.6-sol benched until <at>",
        "model cooldown: codex gpt-5.6-sol reopened, a turn on it served",
    ]);
    expect(lines[0]?.fields).toMatchObject({ provider: "codex", model: "gpt-5.6-sol", reason: COOLING });
    expect(lines[1]?.fields["earlyByMs"]).toBeGreaterThan(0);
});
