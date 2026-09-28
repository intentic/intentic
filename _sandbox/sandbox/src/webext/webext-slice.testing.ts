import { unstubbed } from "@intentic/testing";
import type { WebextSlice } from "./webext-slice.js";

// The owner's-browsers slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const webextSliceFake = () =>
    ({
        // None connected, asked by every planned turn.
        webextReach: async () => undefined,
        // No browser holds a socket, which a sign-in asks before offering the loopback catch (loopback-bridge.ts).
        webextHub: unstubbed<WebextSlice["webextHub"]>("webextHub", { connected: () => [] }),
    }) satisfies Partial<WebextSlice>;
