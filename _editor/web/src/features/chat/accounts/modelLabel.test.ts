/* THE ONE WAY THE APP NAMES A MODEL. */
import { modelLabelFor, perProvider, providerDisplayLabel, providerModels, providerModelsState, readCatalogsWith } from "./providerCatalog";

// The loader as a label reaches it; recorded, never run, so each read is one the resolver itself asked for.
const reads = jest.fn<(provider: string) => void>();

beforeEach(() => {
    providerModels.value = perProvider(() => []);
    providerModelsState.value = perProvider(() => `idle` as const);
    readCatalogsWith(reads);
    jest.useFakeTimers();
    jest.setSystemTime(1_800_000_000_000);
});

afterEach(() => {
    jest.useRealTimers();
    reads.mockClear();
});

it(`names a model its catalog lists by the catalog's own label`, () => {
    providerModels.value = { ...providerModels.value, gemini: [{ label: `Gemini 3.8 Flash`, value: `gemini-3.8-flash-high` }] };
    providerModelsState.value = { ...providerModelsState.value, gemini: `loaded` };

    expect(modelLabelFor(`gemini`, `gemini-3.8-flash-high`)).toBe(`Gemini 3.8 Flash`);
});

// The defect: a chat on a catalog nobody had read showed `claude-opus-5-5` until a picker happened to be opened.
it(`names an id no read catalog lists as a person would, and reads that catalog`, async () => {
    expect(modelLabelFor(`claude`, `claude-opus-5-5`)).toBe(`Claude Opus 5.5`);
    await Promise.resolve();

    expect(reads.mock.calls).toEqual([[`claude`]]);
});

it(`reads a catalog once however often a render asks, and again only after a failed read has cooled`, async () => {
    modelLabelFor(`codex`, `gpt-5-codex`);
    modelLabelFor(`codex`, `gpt-5-codex`);
    await Promise.resolve();
    expect(reads).toHaveBeenCalledTimes(1);

    providerModelsState.value = { ...providerModelsState.value, codex: `error` };
    modelLabelFor(`codex`, `gpt-5-codex`);
    await Promise.resolve();
    expect(reads).toHaveBeenCalledTimes(1);

    jest.setSystemTime(1_800_000_030_000);
    modelLabelFor(`codex`, `gpt-5-codex`);
    await Promise.resolve();
    expect(reads).toHaveBeenCalledTimes(2);
});

it(`leaves a loaded catalog and a provider with none alone, and names an empty pick by its provider`, async () => {
    providerModelsState.value = { ...providerModelsState.value, grok: `loaded` };

    expect(modelLabelFor(`grok`, `grok-9`)).toBe(`Grok 9`);
    expect(modelLabelFor(`acp-agent`, `its-own-model`)).toBe(`Its Own Model`);
    expect(modelLabelFor(`claude`, ``)).toBe(providerDisplayLabel(`claude`));
    await Promise.resolve();

    expect(reads).not.toHaveBeenCalled();
});
