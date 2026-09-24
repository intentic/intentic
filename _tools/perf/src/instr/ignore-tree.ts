import { createIgnoreScope, type IgnoreScope } from "@intentic/workspace-ignore";
import { repoPaths } from "./fixtures.js";
import type { Work } from "./scenario.js";

// Rules shaped like a monorepo's: a root file, and one per group that adds and re-includes.
const ROOT_RULES = ["node_modules", "dist", ".cache", ".turbo", "coverage", "*.log", "/out-tsc", "!docs/**/*.md"].join("\n");
const GROUP_RULES = ["*.generated.ts", "scripts/*.mjs", "!scripts/keep-*.mjs", "fixtures/**/*.json"].join("\n");

/** One pass of the workspace walk's ignore check over 8,000 paths, under a root and a per-group `.gitignore`. */
export const ignoreWalk = (): Work => {
    const paths = repoPaths(2, 8_000);
    const groups = [...new Set(paths.map((path) => path.slice(0, path.indexOf("/"))))].toSorted();
    // The rules arrive as text, as the walker hands them over, so no process reads a file another is writing.
    const top = createIgnoreScope().layer("", ROOT_RULES);
    const scopes = new Map<string, IgnoreScope>(groups.map((group) => [group, top.layer(group, GROUP_RULES)]));
    return () => {
        let ignored = 0;
        for (const path of paths) {
            const scope = scopes.get(path.slice(0, path.indexOf("/")))!;
            const name = path.slice(path.lastIndexOf("/") + 1);
            ignored += scope.isIgnored(name, path, false) ? 1 : 0;
        }
        if (ignored === 0 || ignored === paths.length) {
            throw new Error(`every path answered the same (${ignored} of ${paths.length} ignored); the rules did not load`);
        }
        return ignored;
    };
};
