import { MODELS_PATH, modelsHref, modelsPath } from "./modelsPath";

// One address for every door to Sandbox ▸ Models, so none can drift onto the page's old one (/connect).
it(`names the section bare, and carries only the parts of a request that say something`, () => {
    expect(modelsPath()).toBe(MODELS_PATH);
    expect(modelsPath({ provider: undefined, found: `` })).toBe(`/sandbox/models`);
    expect(modelsPath({ provider: `cursor` })).toEqual({ path: `/sandbox/models`, query: { provider: `cursor` } });
    expect(modelsPath({ found: `claude,codex` })).toEqual({ path: `/sandbox/models`, query: { found: `claude,codex` } });
});

it(`spells the same address as text for the places that hold a plain href`, () => {
    expect(modelsHref()).toBe(`/sandbox/models`);
    expect(modelsHref({ provider: `cursor` })).toBe(`/sandbox/models?provider=cursor`);
    expect(modelsHref({ provider: `endpoint:my server` })).toBe(`/sandbox/models?provider=endpoint%3Amy+server`);
});
