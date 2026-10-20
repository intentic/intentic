import { compareUnrankedModelIds } from "@intentic/sandbox-contract/models/model-order";
import { MINTED_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import type { Model } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { seedModelsOf } from "../../../runtimes/minted/minted-provider.js";
import { recordingLogger } from "../../../harness/route-fakes.testing.js";
import { createCatalogChangeLog, servedModels } from "../provider-registry.js";

// catalogOf/refusing build a fake catalog and a refused-model set, for servedModels: the catalog view after removing
// models the plan refuses.
const catalogOf = (ids: readonly string[], fallback = ids[0]!): Promise<{ models: Model[]; default: string }> =>
    Promise.resolve({ models: ids.map((id) => ({ id, label: id })), default: fallback });

type RegistryStores = Parameters<typeof servedModels>[0];
const refusing = (...ids: readonly string[]): RegistryStores => ({
    modelRefusals: { refused: () => Promise.resolve(new Set(ids)), record: () => Promise.resolve() },
});

test("a refused model comes off the catalog it was refused from", async () => {
    const served = await servedModels(refusing("kimi-k2.7-code-highspeed"), "kimi", catalogOf(["kimi-k3", "kimi-k2.7-code-highspeed"]));
    expect(served.models.map((model) => model.id)).toEqual(["kimi-k3"]);
});

test("a refused default moves to the first model that survives", async () => {
    const served = await servedModels(refusing("kimi-k3"), "kimi", catalogOf(["kimi-k3", "kimi-k2.7-code"]));
    expect(served.default).toBe("kimi-k2.7-code");
});

test("a provider whose every model is refused keeps its catalog whole", async () => {
    const served = await servedModels(refusing("kimi-k3", "kimi-k2.7-code"), "kimi", catalogOf(["kimi-k3", "kimi-k2.7-code"]));
    expect(served.models.map((model) => model.id)).toEqual(["kimi-k3", "kimi-k2.7-code"]);
    expect(served.default).toBe("kimi-k3");
});

test("the filter only drops what the asked-for provider was refused", async () => {
    const served = await servedModels(refusing(), "codex", catalogOf(["gpt-6-astra"]));
    expect(served.models.map((model) => model.id)).toEqual(["gpt-6-astra"]);
});

// A model whose allowance is spent is not a refused one: it comes back on its own, so it stays on the catalog and every
// surface judges the wait from the accounts and the refusals on file (plan-pools.ts fleetCapacity), never from a mark
// the catalog carries (2026-10-09: a mark nothing cleared greyed a model whose turns went through).
test("the catalog carries no capacity of its own: a spent model stays listed as served", async () => {
    const served = await servedModels(refusing(), "codex", catalogOf(["gpt-5.6-sol", "gpt-5.6-terra"]));
    expect(served.models).toEqual([
        { id: "gpt-5.6-sol", label: "gpt-5.6-sol" },
        { id: "gpt-5.6-terra", label: "gpt-5.6-terra" },
    ]);
});

test("every minted provider seeds a non-empty floor whose head survives the catalog's own ordering", () => {
    for (const provider of MINTED_PROVIDERS) {
        const seed = seedModelsOf(provider);
        expect(seed.length, `${provider} seeds nothing`).toBeGreaterThan(0);
        const sorted = [...seed].toSorted((left, right) => compareUnrankedModelIds(left.id, right.id));
        expect(sorted[0]?.id, `${provider}'s seed does not lead with the model its ordering would pick`).toBe(seed[0]?.id);
        for (const model of seed) {
            expect(model.label.trim(), `${provider} seeds a model with no label`).not.toBe("");
        }
    }
});

// A model leaving the picker left no trace; each change of the served ids is one line naming what came and went.
test("the catalog change log writes the starting list, then only what was added or removed", () => {
    const { lines, logger } = recordingLogger();
    const changes = createCatalogChangeLog();
    const models = (...ids: string[]): Model[] => ids.map((id) => ({ id, label: id }));
    changes.note(logger, "gemini", models("gemini-3-pro", "gemini-3-flash"));
    changes.note(logger, "gemini", models("gemini-3-flash", "gemini-3-pro"));
    changes.note(logger, "gemini", models("gemini-3-flash", "gemini-3.5-pro"));
    expect(lines.map((line) => line["message"])).toEqual([
        "model catalog: gemini serves 2 models",
        "model catalog: gemini added gemini-3.5-pro; removed gemini-3-pro",
    ]);
    expect(lines[1]).toMatchObject({ provider: "gemini", added: ["gemini-3.5-pro"], removed: ["gemini-3-pro"], count: 2 });
});
