import { createLogger } from "../../logger.js";
import { testConfig } from "../../testing.js";
import type { CliParts } from "./vendor-cli-slice.js";

// A vendor CLI's parts with nothing signed in, as route suites stand a provider slice up. Not part of the build.

export const cliPartsFake = (defaultLabel: string): CliParts => ({
    store: {
        read: async () => undefined,
        write: async () => {},
        clear: async () => {},
        list: async () => [],
        accounts: async () => [],
        homeOf: (id) => `/nonexistent/${id}`,
        adopt: async () => {},
        logger: createLogger(testConfig),
    },
    models: { models: async () => ({ models: [{ id: "default", label: defaultLabel }], default: "default" }), forget: () => {} },
});
