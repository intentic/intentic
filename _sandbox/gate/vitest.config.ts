import { defineConfig } from "vitest/config";
import { UNIT_SUITE } from "@intentic/testing/vitest";

export default defineConfig({
    test: {
        projects: [{ test: UNIT_SUITE }],
    },
});
