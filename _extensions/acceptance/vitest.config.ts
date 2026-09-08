import { fileURLToPath } from "node:url";
import { packageSourceAliases } from "@intentic/testing/aliases";
import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Aliased to source, per project: `projects` ignores a top-level `resolve`, and a stale `dist` silently drops new
// contract fields.
const resolve = {
    alias: {
        "@intentic/extension-api": here(`../../_shared/extension-api/src`),
        "@intentic/registry": here(`../../_shared/registry/src`),
        ...packageSourceAliases(here(`../../_shared/sandbox-contract`)),
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
