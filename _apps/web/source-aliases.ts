import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* The source-first workspace alias map, shared by vite.config.ts AND vitest.config.ts so app and test
 * resolution can never fork. Libs resolve to their .ts/.vue source, mirroring the tsconfig paths, so an edit
 * in _libs reflects with no rebuild (and Vue-SFC HMR works across the package boundary). Every first-party
 * extension resolves to its true source for two reasons: (1) the app and the extension's lazily-imported .vue
 * view must share ONE host.ts instance — pnpm materializes injected node_modules copies of some ext packages,
 * Vite's dep optimizer pre-bundles them, and the singleton forks: activate() binds one copy while the view
 * reads another -> "host() called before activate()"; (2) an injected copy is a pack-time snapshot — a
 * files:["dist"] dep inside it (extension-api) has no src and only the dist that existed at `pnpm install`,
 * which on a fresh CI checkout is nothing, so resolving through the injected copies breaks before the first
 * build. Skips daemon-only packages (no web src entry). */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const extensionAliases = Object.fromEntries(
    readdirSync(here(`../../_extensions`), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => existsSync(here(`../../_extensions/${entry.name}/src/index.ts`)))
        .map((entry): [string, string] => [
            JSON.parse(readFileSync(here(`../../_extensions/${entry.name}/package.json`), `utf8`)).name,
            here(`../../_extensions/${entry.name}/src/index.ts`),
        ]),
);

export const sourceAliases = (): Record<string, string> => ({
    // Listed before the barrel: a string alias also matches `<key>/…`, so the more specific subpath has to win
    // the lookup. It exists so plain .ts (and its unit tests) can reach the markdown engine without loading
    // the design system's component graph — see _libs/ui/src/markdown/index.ts.
    "@intentic-app/ui/markdown": here("../../_libs/ui/src/markdown/index.ts"),
    "@intentic-app/ui": here("../../_libs/ui/src/index.ts"),
    "@intentic-app/api-contract": here("../../_libs/api-contract/src/index.ts"),
    "@intentic/sandbox-contract": here("../../_libs/sandbox-contract/src/index.ts"),
    "@intentic/extension-api": here("../../_libs/extension-api/src/index.ts"),
    ...extensionAliases,
});
