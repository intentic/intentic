import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "./src/vitest.js";

export default defineConfig({
    test: {
        projects: [{ test: UNIT_SUITE }, { test: INTEGRATION_SUITE }],
    },
});
