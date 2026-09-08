import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Aliased to source, per project (`projects` ignores a top-level `resolve`): the published dist is just a runtime
// bridge that returns nothing outside a running app, so this fails to load rather than to assert.
const resolve = { alias: { "@intentic/extension-ui/format": here(`../../_shared/extension-ui/src/format.ts`) } };

export default defineConfig({
    test: {
        projects: [
            { resolve, test: UNIT_SUITE },
            { resolve, test: INTEGRATION_SUITE },
        ],
    },
});
