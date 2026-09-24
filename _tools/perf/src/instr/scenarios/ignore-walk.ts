import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIgnoreScope, type IgnoreScope } from "@intentic/workspace-ignore";
import { repoPaths } from "../fixtures.js";
import type { Scenario } from "../scenario.js";

// Rules shaped like a monorepo's: a root file, and one per group that adds and re-includes.
const ROOT_RULES = ["node_modules", "dist", ".cache", ".turbo", "coverage", "*.log", "/out-tsc", "!docs/**/*.md"].join("\n");
const GROUP_RULES = ["*.generated.ts", "scripts/*.mjs", "!scripts/keep-*.mjs", "fixtures/**/*.json"].join("\n");

export const scenario: Scenario = {
    what: "the workspace walk's ignore check (IgnoreScope.isIgnored): 8,000 monorepo-shaped paths under two .gitignore layers",
    setup: async () => {
        const paths = repoPaths(2, 8_000);
        const root = join(process.cwd(), ".cache", "ignore-walk");
        const groups = [...new Set(paths.map((path) => path.slice(0, path.indexOf("/"))))].toSorted();
        for (const group of groups) {
            mkdirSync(join(root, group), { recursive: true });
            writeFileSync(join(root, group, ".gitignore"), GROUP_RULES);
        }
        writeFileSync(join(root, ".gitignore"), ROOT_RULES);
        const top = await createIgnoreScope().descend(root, "");
        const scopes = new Map<string, IgnoreScope>();
        for (const group of groups) {
            scopes.set(group, await top.descend(join(root, group), group));
        }
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
    },
};
