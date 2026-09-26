import { unstubbed } from "@intentic/testing";
import { createLogger } from "../../logger.js";
import { testConfig } from "../../testing.js";
import type { ClaudeSlice } from "./claude-provider.js";

// Claude's slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export interface ClaudeFakeOverrides {
    readonly claudeStore?: Partial<ClaudeSlice["claudeStore"]> | undefined;
}

export const claudeSliceFake = ({ claudeStore }: ClaudeFakeOverrides) =>
    ({
        // Connected by default so the /agent guard doesn't short-circuit turns under test; override for disconnected.
        claudeStore: unstubbed("claudeStore", {
            read: async (id) => (id === "default" ? { id: "default", label: "Claude", connectedAt: 0, accessToken: "tok-xyz" } : undefined),
            write: async () => {},
            clear: async () => {},
            list: async () => [{ id: "default", label: "Claude", connectedAt: 0 }],
            withRefreshLock: async (_id, act) => act(),
            logger: createLogger(testConfig),
            ...claudeStore,
        }),
        // Every seat is live: the picker skips only an account no org will serve; an answered turn clears its hold.
        claudeSeats: { read: async () => ({}), refuse: async () => {}, clear: async () => {} },
        // Per-provider catalog the provider module reads directly; mirrors testProviderCatalogs row for row, so
        // overriding one without the other misses the seam.
        claudeModels: { models: async () => ({ models: [{ id: "opus", label: "Opus" }], default: "opus" }) },
    }) satisfies ClaudeSlice;
