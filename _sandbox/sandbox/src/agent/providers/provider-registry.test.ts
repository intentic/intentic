import { capabilitiesOf, compareUnrankedModelIds, MINTED_PROVIDERS, type Model, NATIVE_PROVIDERS } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { seedModelsOf } from "../../runtimes/minted/minted-provider.js";
import { PROVIDER_MODULES, servedModels } from "./provider-registry.js";

// Pins invariants the registry's init guard doesn't message precisely: each module serves its own provider, and an
// adapter-less module is backed by another module's runtime.

test("exactly one module per native provider", () => {
    expect(PROVIDER_MODULES.map((module) => module.id).toSorted()).toEqual([...NATIVE_PROVIDERS].toSorted());
});

test("each module's adapters serve runtimes the contract routes to its provider", () => {
    for (const module of PROVIDER_MODULES) {
        const runtimes = new Set([capabilitiesOf(module.id, "native").runtime, capabilitiesOf(module.id, "claude-code").runtime]);
        for (const adapter of module.adapters) {
            expect(runtimes.has(adapter.runtime), `${module.id} contributes ${adapter.runtime}, which never serves it`).toBe(true);
        }
    }
});

test("a module with no adapter is one another module's runtime serves", () => {
    const provided = new Set(PROVIDER_MODULES.flatMap((module) => module.adapters.map((adapter) => adapter.runtime)));
    for (const module of PROVIDER_MODULES.filter((entry) => entry.adapters.length === 0)) {
        for (const harness of ["native", "claude-code"] as const) {
            const runtime = capabilitiesOf(module.id, harness).runtime;
            expect(provided.has(runtime), `${module.id}/${harness} needs ${runtime}, which no module provides`).toBe(true);
        }
    }
});

test("every module carries a catalog and a readiness rung", () => {
    for (const module of PROVIDER_MODULES) {
        expect(typeof module.catalog, module.id).toBe("function");
        expect(typeof module.ready, module.id).toBe("function");
    }
});

test("every minted provider has a generated module, and it contributes no adapter", () => {
    for (const provider of MINTED_PROVIDERS) {
        const module = PROVIDER_MODULES.find((entry) => entry.id === provider);
        expect(module?.id, `${provider} has no module`).toBe(provider);
        expect(module?.adapters, `${provider} contributes an adapter for a runtime it does not own`).toHaveLength(0);
    }
});

// catalogOf/refusing build a fake catalog and a refused-model set, for servedModels: the catalog view after removing
// models the plan refuses.
const catalogOf = (ids: readonly string[], fallback = ids[0]!): Promise<{ models: Model[]; default: string }> =>
    Promise.resolve({ models: ids.map((id) => ({ id, label: id })), default: fallback });
const refusing = (...ids: readonly string[]): { modelRefusals: { refused: () => Promise<ReadonlySet<string>>; record: () => Promise<void> } } => ({
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
