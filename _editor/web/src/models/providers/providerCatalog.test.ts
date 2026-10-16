// newerVersionOf: the one rule behind the composer pill's "older" word, the picker's older tag, and the newest version a
// new chat opens on. Opus 5 and Opus 5.5 differ by two characters, so the rule has to say which one is behind.
import "@intentic/testing/dom";
import { endpointProviders, newerVersionOf, perProvider, providerModels } from "./providerCatalog";

const listed = (provider: string, ids: readonly string[]): void => {
    providerModels.value = { ...providerModels.value, [provider]: ids.map((id) => ({ label: id, value: id })) };
};

afterEach(() => {
    providerModels.value = perProvider(() => []);
    endpointProviders.value = [];
});

it(`names the newest version of the family for an older one, and nothing for the newest`, () => {
    listed(`claude`, [`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`, `claude-opus-5`, `claude-opus-4-8`]);

    expect(newerVersionOf(`claude`, `claude-opus-5`)?.value).toBe(`claude-opus-5-5`);
    expect(newerVersionOf(`claude`, `claude-opus-4-8`)?.value).toBe(`claude-opus-5-5`);
    expect(newerVersionOf(`claude`, `claude-opus-5-5`)).toBeUndefined();
    // Another family is not a newer version, however new: Fable 5.1 is not "Opus".
    expect(newerVersionOf(`claude`, `claude-fable-5-1`)).toBeUndefined();
});

it(`reads an order the catalog does not keep: a registry lists oldest first`, () => {
    listed(`cursor`, [`claude-opus-5`, `gpt-6-sol`, `claude-opus-5-5`, `gpt-6.1-sol`]);

    expect(newerVersionOf(`cursor`, `claude-opus-5`)?.value).toBe(`claude-opus-5-5`);
    expect(newerVersionOf(`cursor`, `gpt-6-sol`)?.value).toBe(`gpt-6.1-sol`);
});

it(`says nothing for a model the catalog does not list, or before it has answered`, () => {
    expect(newerVersionOf(`claude`, `claude-opus-5`)).toBeUndefined();
    listed(`claude`, [`claude-opus-5-5`]);
    expect(newerVersionOf(`claude`, `claude-opus-5`)).toBeUndefined();
});

it(`leaves endpoint models alone: a newer local model is another download, not a newer version`, () => {
    endpointProviders.value = [{ id: `endpoint/ollama`, label: `Ollama`, kind: `localmodel` }];
    listed(`endpoint/ollama`, [`phi-3`, `phi-4`]);

    expect(newerVersionOf(`endpoint/ollama`, `phi-3`)).toBeUndefined();
});
