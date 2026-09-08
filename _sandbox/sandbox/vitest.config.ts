import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { packageSourceAliases } from "@intentic/testing/aliases";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Aliases the contract to source: vitest's externalized resolution is Node's, which ignores Vite's condition.
const sourceAlias = packageSourceAliases(here(`../../_shared/sandbox-contract`));

export default defineConfig({
    test: {
        projects: [
            // Engine fence applies to both projects since ordinary unit code can trigger it, not just integration
            // suites.
            { resolve: { alias: sourceAlias }, test: { ...UNIT_SUITE, setupFiles: [here(`./src/fences/engine-fence.ts`)] } },
            // Integration suites default to the daemon's own tmux socket; this fence gives the project a private one.
            {
                resolve: { alias: sourceAlias },
                test: { ...INTEGRATION_SUITE, setupFiles: [here(`./src/fences/tmux-fence.ts`), here(`./src/fences/engine-fence.ts`)] },
            },
        ],
    },
});
