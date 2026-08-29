import { defineConfig } from "vitest/config";
import { UNIT_SUITE } from "@intentic/testing/vitest";

/* Unit only. Everything here that can be tested without a browser is pure: the page walk (in jsdom), the
 * policy decisions, the tool dispatch against a fake `chrome`. What is left needs a real Chrome with a real
 * extension loaded in it, which is a person's job rather than a suite's.
 *
 * jsdom because the page walk under test IS DOM code, and `@intentic/src` because this package imports the
 * contract and the browser vocabulary from source, like every other workspace consumer does — the widget's
 * config explains both, and the same `exclude` copy is needed for the same readonly-array reason. */
const resolve = { conditions: [`@intentic/src`] };

export default defineConfig({
    test: {
        projects: [{ resolve, test: { ...UNIT_SUITE, exclude: [...UNIT_SUITE.exclude], environment: `jsdom` as const } }],
    },
});
