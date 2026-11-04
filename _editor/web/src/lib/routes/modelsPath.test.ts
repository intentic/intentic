import { insidePath, page } from "@intentic/sandbox-contract/app-routes";
import { activeSandboxId } from "../../app/storage/activeSandbox";
import { MODELS_PATH, modelsHref, modelsPath } from "./modelsPath";

// One address for every door to Sandbox ▸ Models, so none can drift onto the page's old one (/connect), made where the
// reader is: inside the sandbox open, with no route to say otherwise.

const BOX = `a1b2c3d4e5f6`;
beforeEach(() => {
    activeSandboxId.value = BOX;
});

it(`names the section bare, and carries only the parts of a request that say something`, () => {
    expect(modelsPath()).toBe(insidePath(BOX, page.sandboxSettings(`models`)));
    expect(modelsPath({ provider: undefined, found: `` })).toBe(`/s/${BOX}/settings/models`);
    expect(modelsPath({ provider: `cursor` })).toBe(`/s/${BOX}/settings/models?provider=cursor`);
    expect(modelsPath({ found: `claude,codex` })).toBe(`/s/${BOX}/settings/models?found=claude%2Ccodex`);
});

it(`spells the same address as text for the places that hold a plain href`, () => {
    expect(modelsHref()).toBe(`/s/${BOX}/settings/models`);
    expect(modelsHref({ provider: `cursor` })).toBe(`/s/${BOX}/settings/models?provider=cursor`);
    expect(modelsHref({ provider: `endpoint:my server` })).toBe(`/s/${BOX}/settings/models?provider=endpoint%3Amy+server`);
});

it(`keeps the page's address from before frames for a door that names it once, which the router opens where it is pressed`, () => {
    expect(MODELS_PATH).toBe(`/sandbox/models`);
});
