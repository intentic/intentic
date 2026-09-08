import { opendir, readFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { pathExists } from "../../path-exists.js";
import { readWorkspaceManifests } from "./package-graph.js";

// Dependency drift: an installed tree that no longer satisfies the manifests above it, missed by workspace-setup's
// node_modules check. Checks resolvability, not lockfile agreement: overrides/catalogs false-positive, and a lockfile
// importer can still have zero node_modules. Doesn't claim a version is stale, only that a name fails to resolve.

// Only these two blocks: optional deps may be absent by design, peer deps are the consumer's to provide.
const INSTALLED_BLOCKS = ["dependencies", "devDependencies"] as const;

// Runaway guard: a manifest past this has nobody installing it, so stop instead of stalling the daemon.
const MAX_DEPENDENCIES = 20_000;

// One package that can't resolve everything it declares; `dir` is relative to the project (the install root), so "" is
// the project's own manifest.
export interface UnresolvedPackage {
    readonly dir: string;
    readonly names: readonly string[];
}

const declaredNames = (manifest: Record<string, unknown>): string[] => {
    const names = new Set<string>();
    for (const block of INSTALLED_BLOCKS) {
        const deps = manifest[block];
        if (typeof deps === "object" && deps !== null) {
            for (const name of Object.keys(deps)) {
                names.add(name);
            }
        }
    }
    return [...names];
};

// Checks both node_modules layouts: pnpm's isolated layout symlinks deps into the package's tree, npm/yarn hoist to the
// install root. An unrelated ancestor's tree resolving something is not this project's install.
const resolves = async (root: string, packageDir: string, name: string): Promise<boolean> =>
    (await pathExists(join(root, packageDir, "node_modules", name))) || (packageDir !== "" && (await pathExists(join(root, "node_modules", name))));

const manifestAt = async (dir: string): Promise<Record<string, unknown> | undefined> => {
    const text = await readFile(join(dir, "package.json"), "utf8").catch(() => undefined);
    if (text === undefined) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
};

// Root manifest is checked separately from workspace members: their globs never name the root, and a single-package
// project has no members. Empty means every dependency resolves, not that versions are right.
export const unresolvedDependencies = async (projectDir: string): Promise<UnresolvedPackage[]> => {
    const members = readWorkspaceManifests(projectDir).map(({ dir, manifest }) => ({ dir, manifest }));
    const root = await manifestAt(projectDir);
    const packages = [...(root === undefined ? [] : [{ dir: "", manifest: root }]), ...members];

    let budget = MAX_DEPENDENCIES;
    const found = await Promise.all(
        packages.map(async ({ dir, manifest }) => {
            const names = declaredNames(manifest).slice(0, Math.max(0, budget));
            budget -= names.length;
            const missing = await Promise.all(names.map(async (name) => ((await resolves(projectDir, dir, name)) ? undefined : name)));
            return { dir, names: missing.filter((name): name is string => name !== undefined) };
        }),
    );
    return found.filter((entry) => entry.names.length > 0).toSorted((left, right) => left.dir.localeCompare(right.dir));
};

// Walks up like TypeScript's resolver, tracking the nearest package.json and nearest node_modules separately. `absent`
// and `installed` stay apart: they send a reader in opposite directions.
export type NearbyModules = { readonly kind: "absent" } | { readonly kind: "installed"; readonly missing: readonly string[] };

// An install root must have something IN it: an isolated turn's node_modules is empty everywhere on its path, and an
// empty one made every dependency read as missing. Opens the directory, not a full listing, since one entry suffices.
const installedAt = async (modules: string): Promise<boolean> => {
    const dir = await opendir(modules).catch(() => undefined);
    if (dir === undefined) {
        return false;
    }
    try {
        return (await dir.read()) !== null;
    } finally {
        await dir.close();
    }
};

export const modulesNear = async (file: string): Promise<NearbyModules> => {
    let packageDir: string | undefined;
    let installRoot: string | undefined;
    for (let dir = dirname(resolvePath(file)); installRoot === undefined;) {
        packageDir ??= (await pathExists(join(dir, "package.json"))) ? dir : undefined;
        if (await installedAt(join(dir, "node_modules"))) {
            installRoot = dir;
            break;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return { kind: "absent" };
        }
        dir = parent;
    }
    // An install root with no manifest above the file says nothing about its imports: not drift, not worth it.
    if (packageDir === undefined) {
        return { kind: "installed", missing: [] };
    }
    const manifest = await manifestAt(packageDir);
    const names = manifest === undefined ? [] : declaredNames(manifest);
    const missing = await Promise.all(
        names.map(async (name) =>
            (await pathExists(join(packageDir, "node_modules", name))) || (await pathExists(join(installRoot, "node_modules", name))) ? undefined : name,
        ),
    );
    return { kind: "installed", missing: missing.filter((name): name is string => name !== undefined) };
};

// How many missing names a sentence shows; the install-or-don't decision is already made by the third one.
const SAMPLE = 4;

// Distinct names, though the count elsewhere is per package: one shared library missing from six packages is one name
// here, not six repeats. Written for embedding: no leading capital, no trailing period.
export const unresolvedSummary = (unresolved: readonly UnresolvedPackage[]): string => {
    const names = [...new Set(unresolved.flatMap((entry) => entry.names))];
    const shown = names.slice(0, SAMPLE).join(", ");
    return names.length <= SAMPLE ? shown : `${shown} and ${names.length - SAMPLE} more`;
};
