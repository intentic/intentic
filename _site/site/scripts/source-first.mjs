/* RESOLVE WORKSPACE PACKAGES TO THEIR TYPESCRIPT SOURCE, in every Vite environment this build has.
 *
 * `vite.resolve.conditions` in astro.config.mjs asks for exactly this and only gets half of it. Astro builds the
 * site in four environments — `client`, `ssr`, `astro` and `prerender` — and gives the last two a conditions list
 * of its own, so a top-level `resolve.conditions` reaches the first two and is silently absent from `prerender`,
 * which is the environment that renders /api (`generating static routes`). Setting `vite.environments.prerender`
 * does not reach it either: Astro rebuilds that environment's config and drops what the user put there. A `pre`
 * plugin runs ahead of Vite's own resolver in all four, which is why the rule lives here instead of in config.
 *
 * WHAT READING `dist/` COSTS, and why this is a correctness fix rather than a preference for source maps. This
 * workspace sets `injectWorkspacePackages: true` (pnpm-workspace.yaml), so an in-repo dependency is not symlinked
 * into its consumers — it is COPIED into `node_modules/.pnpm/`. pnpm refreshes that copy after the package's own
 * `build` script runs (`syncInjectedDepsAfterScripts`), and a turbo cache hit does not run it. So on a green
 * pipeline the copy holds whatever `pnpm install` found on a `clean: false` runner, while turbo restores the
 * current `dist` to the workspace — two different builds of one package, and Node reads the stale one.
 *
 * A module added to a package since that copy was taken is then simply absent, and the error names the package
 * that is fine rather than the arrangement that is not:
 *
 *     Cannot find module …/@intentic/sandbox-contract/dist/documents.js
 *       imported from …/@intentic/sandbox-contract/dist/index.js
 *
 * which is CI run 32871141950 — and the push after it went green with nothing between them that touched this
 * site, because the second runner's turbo cache happened to miss.
 *
 * SO WHY CHECKOUT `src/` IS SOUND WHERE INJECTED `dist/` IS NOT. Source is git-tracked and current before the
 * build starts; dist is not tracked and turbo produces it only after the install. The resolver uses the injected
 * package to prove the importer really has that dependency, then follows the package's repository directory back
 * to the checkout and reads the source condition there.
 *
 * It must not join the source target onto the injected package itself. pnpm materializes those packages according
 * to their published files: `@intentic/constants`, for example, deliberately ships `dist/` plus its hand-written
 * Node helper, not `src/index.ts`. Its export map still carries `@intentic/src` for workspace tools, so resolving
 * that target inside the injected copy produces an unloadable dependency even when the checkout is completely
 * healthy. The checkout is the source of truth for both the current manifest and the file the condition names.
 */

import { repoRoot } from "@intentic/constants/node";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The scopes every in-repo package is published under. A bare id outside them is a real dependency. */
const WORKSPACE_SCOPES = [`@intentic/`, `@intentic-app/`, `@intentic-dev/`];

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

/* The package manifest owning a resolved entry file: walk up until a package.json appears. Bounded by the
 * filesystem root, so a resolution that somehow lands outside a package ends as undefined rather than looping. */
const packageManifestOf = (file) => {
    let directory = dirname(file);
    for (;;) {
        try {
            return JSON.parse(readFileSync(join(directory, `package.json`), `utf8`));
        } catch {
            const parent = dirname(directory);
            if (parent === directory) return undefined;
            directory = parent;
        }
    }
};

/* The `@intentic/src` target for one subpath of an exports map. Walks the nested condition objects looking only
 * for that key: the map's own ordering does not matter here, because the question is not "what would a resolver
 * pick" but "does this package publish a source entry for this subpath, and where". */
const sourceTarget = (node) => {
    if (typeof node === `string`) return undefined;
    if (node === null || typeof node !== `object`) return undefined;
    if (typeof node[SOURCE_CONDITION] === `string`) return node[SOURCE_CONDITION];
    for (const value of Object.values(node)) {
        const found = sourceTarget(value);
        if (found !== undefined) return found;
    }
    return undefined;
};

export const sourceFirstWorkspace = () => ({
    name: `intentic:source-first-workspace`,
    // Ahead of `vite:resolve`, which is what decides `dist/` and what externalizes the package out of Vite's
    // reach entirely. Once this answers with a path inside the workspace, neither happens.
    enforce: `pre`,
    resolveId(id, importer) {
        if (!WORKSPACE_SCOPES.some((scope) => id.startsWith(scope))) return null;
        const [name, subpath] = splitSubpath(id);

        /* FROM THE IMPORTER, not from this file. Only the site's own direct dependencies resolve from here, and
         * the packages that matter most are reached through each other: the site imports sandbox-openapi, whose
         * source imports sandbox-contract, which the site does not depend on and cannot resolve. Resolving those
         * against this plugin's own location answers "not found", the id falls through to Vite, and the one hop
         * that had to read source is the hop that goes back to reading `dist/`. */
        let resolved;
        try {
            // Node's own resolution, used ONLY to find where the package lives — its answer is the `dist/` entry
            // this plugin exists to avoid, and it is thrown away once the directory has been read off it.
            resolved = createRequire(importer ?? import.meta.url).resolve(name);
        } catch {
            return null;
        }
        const installedManifest = packageManifestOf(resolved);
        if (installedManifest === undefined) return null;

        const workspaceDirectory = installedManifest.repository?.directory;
        if (workspaceDirectory === undefined) return null;

        const directory = join(WORKSPACE_ROOT, workspaceDirectory);
        const manifest = JSON.parse(readFileSync(join(directory, `package.json`), `utf8`));
        if (manifest.name !== name) return null;

        const target = sourceTarget(manifest.exports?.[subpath]);
        // No source entry for this subpath is a legitimate answer — a package may publish only built output — so
        // hand it back to Vite rather than failing the build on a package this rule has nothing to say about.
        return target === undefined ? null : join(directory, target);
    },
});
