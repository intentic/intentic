import type { EnvironmentSources } from "./environment-sources.js";

// The overlay's fragment sources as a suite fills the port: nothing contributes but what `over` names, so a composed
// overlay holds only the suite's own fragments. A suite composing real capabilities and extensions fills the port with
// `environmentSourcesOf` (environment-sources.ts) over its own services instead, as composition.ts does.
export const environmentSourcesFake = (over: Partial<EnvironmentSources> = {}): EnvironmentSources => ({
    capabilityFragments: async () => [],
    workspaceExtensionFragments: async () => [],
    providerPackFragments: async () => [],
    ...over,
});
