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
    }) satisfies Partial<DepsSlice>;
