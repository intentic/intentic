import type { Services } from "./composition.js";
import { providerPackFragments } from "./agent/providers/provider-packs.js";
import { capabilityFragments, workspaceExtensionFragments } from "./extensions/fragment-sources.js";
import type { EnvironmentSources } from "./seams/environment-sources.js";

/** The environment's fragment sources over the finished services, read per call: what createServices fills, and what a
 * suite that composes a real overlay fills too. */
export const environmentSourcesOf = (services: () => Services): EnvironmentSources => ({
    capabilityFragments: (capability) => capabilityFragments(services(), capability),
    workspaceExtensionFragments: () => workspaceExtensionFragments(services()),
    providerPackFragments: () => providerPackFragments(services()),
});
