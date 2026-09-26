import type { SliceFakeContext } from "../harness/slice-fake.testing.js";
import { pairings } from "../peers/enrollment.js";
import { enrolledFleet, syncPairBurns, type SyncMode } from "./desktop-sync.js";
import type { HostsSlice } from "./hosts-slice.js";

// The hosts slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const hostsSliceFake = ({ historyRoot }: SliceFakeContext) =>
    ({
        // Real pairing table so mint and redeem share one implementation, following the test's own history root.
        syncPairings: pairings<SyncMode>(syncPairBurns(historyRoot)),
        // No connected device, which is what the daemon answers with no host card granted; every planned turn asks,
        // so every route running a turn needs it.
        hostReach: async () => undefined,
        // Composed exactly as composition.ts composes it, over this harness's own history root, so a suite exercises
        // the real reader rather than a second description of it.
        syncFleet: () => enrolledFleet(historyRoot),
    }) satisfies Partial<HostsSlice>;
