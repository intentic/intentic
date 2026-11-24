import type { Services } from "../../../composition.js";
import type { ChildSpawnSpec } from "../children.js";
import { CHILD_EFFORT, withChildEffort } from "../spawn-catalog.js";

// A spawn that names no effort runs at extra-high where its model offers it: left to the runtime's default, every child
// of 2026-11-24 ran at medium while its parent ran at extra-high.

// Every provider answers with the same catalog, so the lookup by the spec's own provider is what is tested.
// SAFETY: the proxy answers every provider key withChildEffort may read, with the one method it calls.
const catalogs = (models: readonly { id: string; efforts?: string[] }[], fails = false): Pick<Services, "providerCatalogs"> => ({
    providerCatalogs: new Proxy({} as Services["providerCatalogs"], {
        get: () => ({ models: async () => (fails ? Promise.reject(new Error(`down`)) : { models: models.map((model) => ({ label: model.id, ...model })) }) }),
    }),
});
const OPUS = { id: `claude-opus-5-5`, efforts: [`low`, `medium`, `high`, `xhigh`, `max`] };
const HAIKU = { id: `claude-haiku-5-5`, efforts: [`low`, `medium`] };
const OPUS_SPEC: ChildSpawnSpec = { prompt: `p`, provider: `claude`, model: `claude-opus-5-5` };

test(`a spawn naming no effort runs at extra-high where its model offers it`, async () => {
    const spec = await withChildEffort(catalogs([OPUS]), OPUS_SPEC);
    expect(spec.effort).toBe(CHILD_EFFORT);
});

test(`an effort the spawn names is kept, whatever the model offers`, async () => {
    const spec = await withChildEffort(catalogs([OPUS]), { ...OPUS_SPEC, effort: `medium` });
    expect(spec.effort).toBe(`medium`);
});

test(`a model that does not offer extra-high, names no levels, is not listed, or whose catalog fails keeps its own default`, async () => {
    const asked: ChildSpawnSpec = { prompt: `p`, provider: `claude`, model: `claude-haiku-5-5` };
    expect((await withChildEffort(catalogs([HAIKU]), asked)).effort).toBeUndefined();
    expect((await withChildEffort(catalogs([{ id: `claude-haiku-5-5` }]), asked)).effort).toBeUndefined();
    expect((await withChildEffort(catalogs([OPUS]), asked)).effort).toBeUndefined();
    expect((await withChildEffort(catalogs([HAIKU], true), asked)).effort).toBeUndefined();
});
