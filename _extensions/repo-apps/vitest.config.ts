import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// The kit's translator as source: dist/i18n.js is a bridge into a running host and throws the moment it is
// imported without one. Vitest externalizes it, and Node's resolution ignores Vite's conditions, so it takes an alias.
const resolve = { alias: { "@intentic/extension-ui/i18n": here(`../../_shared/extension-ui/src/i18n.ts`) } };

export default defineConfig({
    test: {
        projects: [
            { resolve, test: UNIT_SUITE },
            { resolve, test: INTEGRATION_SUITE },
        ],
    },
});
