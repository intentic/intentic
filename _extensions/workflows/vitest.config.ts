import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Alias to source, not dist: Node resolves externalized deps, ignoring Vite conditions. Set per project.
const resolve = {
    alias: {
        "@intentic/extension-ui/i18n": here(`../../_shared/extension-ui/src/i18n.ts`),
        "@intentic/sandbox-contract": here(`../../_shared/sandbox-contract/src/index.ts`),
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
