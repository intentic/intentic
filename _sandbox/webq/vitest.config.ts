import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

/* The unit suite is pure in-memory transforms (HTML → markdown, pruning, BM25, robots parsing); the
 * integration suite boots a loopback HTTP server serving a fixture site and drives the CLI end to end
 * against it — machine work, so it gets the integration budget from the shared config. */
export default defineConfig({
    test: {
        projects: [{ test: UNIT_SUITE }, { test: INTEGRATION_SUITE }],
    },
});
