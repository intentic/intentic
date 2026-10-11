import { createLogger } from "../../logger.js";
import { testConfig } from "../../testing.js";
import type { DevinSlice } from "./devin-provider.js";

// Devin's slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const devinSliceFake = () =>
    ({
        // Nothing connected: nothing guards on Devin, so the honest default is unset up.
        devinStore: {
            read: async () => undefined,
            write: async () => {},
            clear: async () => {},
            list: async () => [],
            credentials: async () => [],
            logger: createLogger(testConfig),
        },
        devinModels: { models: async () => ({ models: [{ id: "default", label: "Devin's default" }], default: "default" }), forget: () => {} },
    }) satisfies DevinSlice;
