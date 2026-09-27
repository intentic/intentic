import { unstubbed } from "@intentic/testing";
import type { DepsSlice } from "./deps-slice.js";

// The dependencies slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const depsSliceFake = () =>
    ({
        dependencies: unstubbed<DepsSlice["dependencies"]>("dependencies", {
            status: async () => [],
            issueAt: async () => undefined,
            requestInstall: async () => ({ projects: [], queued: [] }),
            reconcileLand: async () => undefined,
            watch: () => () => {},
            subscribe: () => () => {},
            subscribeFailures: () => () => {},
        }),
        // Nothing pushed yet: GET /workspace/push-checks serves an empty record.
        pushChecks: unstubbed<DepsSlice["pushChecks"]>("pushChecks", {
            store: unstubbed<DepsSlice["pushChecks"]["store"]>("pushChecks.store", {
                read: async () => ({ pushes: [], reds: {}, ended: {}, seen: [] }),
            }),
        }),
    }) satisfies Partial<DepsSlice>;
