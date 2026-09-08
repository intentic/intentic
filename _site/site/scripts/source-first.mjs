// Resolves workspace packages to TS source in all four Vite environments; astro's `resolve.conditions` doesn't reach
// `prerender`, so this runs as a `pre` plugin. Locates the checkout via the injected package's `repository.directory`
// and resolves source there, never inside the injected copy (which pnpm can leave stale).

import { repoRoot } from "@intentic/constants/node";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The scopes every in-repo package is published under. A bare id outside them is a real dependency. */
const WORKSPACE_SCOPES = [`@intentic/`, `@intentic/`, `@intentic/`];

/** The condition each package's exports map lists ahead of its `default`, pointing at the entry's `.ts`. */
const SOURCE_CONDITION = `@intentic/src`;

/** The checkout containing this private build plugin, discovered rather than inferred from the file's depth. */
const WORKSPACE_ROOT = repoRoot(import.meta.url);

/** `@scope/name/sub/path` → `["@scope/name", "./sub/path"]`; a bare package id gets the `"."` subpath. */
const splitSubpath = (id) => {
    const parts = id.split(`/`);
    const name = `${parts[0]}/${parts[1]}`;
    const rest = parts.slice(2).join(`/`);
    return [name, rest === `` ? `.` : `./${rest}`];
};

// The package manifest owning a resolved entry file: walks up until a package.json appears, bounded by the filesystem
// root to avoid looping.
const packageManifestOf = (file) => {
    let directory = dirname(file);
    for (;;) {
        try {
            return JSON.parse(readFileSync(join(directory, `package.json`), `utf8`));
        } catch {
            const parent = dirname(directory);
            if (parent === directory) {
                return undefined;
            }
            directory = parent;
        }
    }
};

// The `@intentic/src` target for one subpath of an exports map; walks nested condition objects for that key only, since
// order doesn't matter here.
const sourceTarget = (node) => {
    if (typeof node === `string`) {
        return undefined;
    }
    if (node === null || typeof node !== `object`) {
        return undefined;
    }
    if (typeof node[SOURCE_CONDITION] === `string`) {
        return node[SOURCE_CONDITION];
    }
    for (const value of Object.values(node)) {
        const found = sourceTarget(value);
        if (found !== undefined) {
            return found;
        }
    }
    return undefined;
};

export const sourceFirstWorkspace = () => ({
    name: `intentic:source-first-workspace`,
    // Ahead of `vite:resolve`, which picks dist/ and can externalize the package; answering first prevents both.
    enforce: `pre`,
    resolveId(id, importer) {
        if (!WORKSPACE_SCOPES.some((scope) => id.startsWith(scope))) {
            return null;
        }
        const [name, subpath] = splitSubpath(id);

        // From the importer, not this file: a transitive dep reached only through another package can't resolve.
        let resolved;
        try {
            // Node resolution only locates the package; its dist/ answer itself is discarded, not used as the result.
            resolved = createRequire(importer ?? import.meta.url).resolve(name);
        } catch {
            return null;
        }
        const installedManifest = packageManifestOf(resolved);
        if (installedManifest === undefined) {
            return null;
        }

        const workspaceDirectory = installedManifest.repository?.directory;
        if (workspaceDirectory === undefined) {
            return null;
        }

        const directory = join(WORKSPACE_ROOT, workspaceDirectory);
        const manifest = JSON.parse(readFileSync(join(directory, `package.json`), `utf8`));
        if (manifest.name !== name) {
            return null;
        }

        const target = sourceTarget(manifest.exports?.[subpath]);
        // No source entry is legitimate (a package may ship only built output); hand back to Vite, don't fail.
        return target === undefined ? null : join(directory, target);
    },
});
