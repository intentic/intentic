import { join } from "node:path";
import { plugin } from "bun";
import { repoRoot } from "@intentic/constants/node";
// The app's own preload first: its catalog, env, browser gaps and source aliases. The page compiles the app's chat
// components directly (vite.config.ts), so a test resolves them the same way the build does.
import "../web/bun.setup.ts";

const fromRoot = (path: string): string => join(repoRoot(import.meta.url), path);

// The two aliases vite.config.ts states ahead of the workspace ones: the app by source, the design system by file.
const aliases: readonly (readonly [string, string])[] = [
    [`@intentic/web`, fromRoot(`_editor/web/src`)],
    [`@intentic/ui/src`, fromRoot(`_editor/ui/src`)],
];

plugin({
    name: `share-view-test-resolution`,
    setup(build) {
        build.onResolve({ filter: /^@intentic\/(web|ui\/src)(\/|$)/ }, ({ path }) => {
            const hit = aliases.find(([key]) => path === key || path.startsWith(`${key}/`));
            return hit === undefined ? undefined : { path: hit[1] + path.slice(hit[0].length) };
        });
    },
});
