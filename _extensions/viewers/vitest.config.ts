import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Aliased to source, per project (`projects` ignores a top-level `resolve`): the published dist is just a runtime
// bridge that throws outside a running app, so this fails to load rather than to assert. Same line, same reason, as
// _extensions/activity/vitest.config.ts.
const resolve = {
    alias: {
        "@intentic/extension-ui/i18n": here(`../../_shared/extension-ui/src/i18n.ts`),
        "@intentic/extension-ui/format": here(`../../_shared/extension-ui/src/format.ts`),
    },
};

export default defineConfig({
    test: {
        projects: [
            { resolve, test: UNIT_SUITE },
            { resolve, test: INTEGRATION_SUITE },
        ],
    },
});
