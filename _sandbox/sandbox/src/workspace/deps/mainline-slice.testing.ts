import { unstubbed } from "@intentic/testing";
import type { MainlineSlice } from "./mainline-slice.js";

// The main line's slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

// No project is red here, so no red streak is kept.
const noStreaks = async (): Promise<Record<string, never>> => ({});

export const mainlineSliceFake = () =>
    ({
        dependencies: unstubbed<MainlineSlice["dependencies"]>("dependencies", {
            status: async () => [],
            issueAt: async () => undefined,
            requestInstall: async () => ({ projects: [], queued: [] }),
            reconcileLand: async () => undefined,
            watch: () => () => {},
            subscribe: () => () => {},
            subscribeFailures: () => () => {},
        }),
        // The main line's verdicts: nothing checked yet. Every planned turn that owes the checks-after-landing note reads
        // them, and GET /workspace/mainline serves them.
        verifyStore: unstubbed<MainlineSlice["verifyStore"]>("verifyStore", {
            read: async () => ({ projects: {}, runs: [] }),
            lands: async () => ({}),
            streaks: noStreaks,
        }),
        // Nothing is checked after a land here: the land check's own suite stands it up (verify-deps.integration.test.ts).
        landCheck: unstubbed<MainlineSlice["landCheck"]>("landCheck", { enqueue: () => {}, current: () => undefined, ahead: async () => false }),
        // Nothing pushed yet: GET /workspace/mainline serves the pushes beside the verdicts.
        pushChecks: unstubbed<MainlineSlice["pushChecks"]>("pushChecks", {
            store: unstubbed<MainlineSlice["pushChecks"]["store"]>("pushChecks.store", { read: async () => ({ pushes: [], seen: [] }) }),
        }),
    }) satisfies Partial<MainlineSlice>;
