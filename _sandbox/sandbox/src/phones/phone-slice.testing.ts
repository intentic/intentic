import { unstubbed } from "@intentic/testing";
import type { PhonesSlice } from "./phone-slice.js";

// The owner's-phones slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const phonesSliceFake = () =>
    ({
        // None connected, asked by every planned turn.
        phoneReach: async () => undefined,
        phoneHub: unstubbed<PhonesSlice["phoneHub"]>("phoneHub", { connected: () => [] }),
    }) satisfies Partial<PhonesSlice>;
