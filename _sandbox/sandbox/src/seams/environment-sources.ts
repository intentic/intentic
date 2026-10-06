import type { Capability } from "@intentic/sandbox-contract";

// Where the overlay's contributed fragments come from, as environment/ reads them. The composers sit above the
// environment (a capability's handler and an extension's checkout in extensions/fragment-sources.ts, a connected
// provider's packs in agent/providers/provider-packs.ts), so composeEnvironment and the contents view take them through
// this port, which composition.ts fills, rather than importing up.
export interface EnvironmentSources {
    /** Every fragment one capability contributes: its handler's own blocks, then an extension or cli connector's file. */
    readonly capabilityFragments: (capability: Capability) => Promise<string[]>;
    /** The fragments the workspace's own enabled extensions declare, which have no capability entry. */
    readonly workspaceExtensionFragments: () => Promise<string[]>;
    /** The packs the connected AI providers need, for a base image that does not already bake them. */
    readonly providerPackFragments: () => Promise<string[]>;
}
