import { unstubbed } from "@intentic/testing";
import { createFileTickets } from "./file-tickets.js";
import type { WebextSlice } from "./webext-slice.js";

// The owner's-browsers slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const webextSliceFake = () =>
    ({
        // None connected, asked by every planned turn.
        webextReach: async () => undefined,
        // No browser holds a socket, which a sign-in asks before offering the loopback catch (loopback-bridge.ts).
        webextHub: unstubbed<WebextSlice["webextHub"]>("webextHub", { connected: () => [] }),
        // A suite that types a secret into the owner's browser stubs the half it reaches; anything else says its name.
        secretTickets: unstubbed<WebextSlice["secretTickets"]>("secretTickets", {}),
        // The real desk: it lets every message but an `upload_file` pass untouched, and touches no disk until one comes.
        fileTickets: createFileTickets(),
    }) satisfies Partial<WebextSlice>;
