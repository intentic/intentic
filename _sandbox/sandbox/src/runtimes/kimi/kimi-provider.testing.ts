import type { KimiSlice } from "./kimi-provider.js";

// Kimi's slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const kimiSliceFake = () =>
    ({
        // Per-provider catalog the provider module reads directly; mirrors testProviderCatalogs row for row.
        kimiModels: { models: async () => ({ models: [{ id: "kimi-k3", label: "Kimi K3" }], default: "kimi-k3" }) },
    }) satisfies KimiSlice;
