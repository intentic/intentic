import { defineConfig } from "vitest/config";
import { UNIT_SUITE } from "@intentic/testing/vitest";

/* Unit only. */
const resolve = { conditions: [`@intentic/src`] };

export default defineConfig({
    test: {
        projects: [{ resolve, test: { ...UNIT_SUITE, exclude: [...UNIT_SUITE.exclude], environment: `jsdom` as const } }],
    },
});
