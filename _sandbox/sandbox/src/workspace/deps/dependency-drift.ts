import { opendir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { pathExists } from "@intentic/base/fs";
import { parse, YAMLError } from "yaml";
import { readWorkspaceManifests } from "./package-graph.js";

// Dependency drift: an installed tree that no longer satisfies what is declared above it, missed by workspace-setup's
// node_modules check. Two readings of the tree itself, never of pnpm's own install record: a name that fails to resolve
// against the manifests (a lockfile importer can have zero node_modules), and a direct dependency installed at another
// version than the committed lockfile resolves (a catalog bump leaves every name resolving).

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

// One direct dependency installed at another version than the lockfile resolves; `dir` is relative to the project.
export interface OutdatedDependency {
    readonly dir: string;
    readonly name: string;
    readonly installed: string;
    readonly locked: string;
}

// Each lockfile document's top-level `importers:` block, up to the next top-level key or the end: parsing the whole
// lockfile (its `packages:` and `snapshots:`) blocks the event loop for about a second on a large monorepo.
const IMPORTERS_BLOCK = /^importers:\n([\s\S]*?)(?=^\S|(?![\s\S]))/gm;

// Semver ignores build metadata, and a canary's installed manifest carries it where its lockfile entry does not.
const withoutBuild = (version: string): string => version.split("+")[0] ?? version;

type LockedVersions = ReadonlyMap<string, ReadonlyMap<string, string>>;

// Importer dir (relative, "" for the root) → direct dependency name → the version the lockfile resolves. Only
// registry versions: `link:`, `file:` and git entries have no version a manifest could disagree with, and a peer
// suffix (`1.3.0(zod@4.5.4)`) is not part of the installed version.
const recordOf = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

const registryVersion = (entry: unknown): string | undefined => {
    const version = recordOf(entry)["version"];
    return typeof version === "string" && /^\d/.test(version) ? (version.split("(")[0] ?? version) : undefined;
};

const importerVersions = (importer: unknown, into: Map<string, string>): void => {
    for (const block of INSTALLED_BLOCKS) {
        for (const [name, entry] of Object.entries(recordOf(recordOf(importer)[block]))) {
            const version = registryVersion(entry);
            if (version !== undefined) {
                into.set(name, version);
            }
        }
    }
};

const lockedVersionsOf = (text: string): LockedVersions => {
    const importers = new Map<string, Map<string, string>>();
    for (const match of text.matchAll(IMPORTERS_BLOCK)) {
        const entries = recordOf(recordOf(parse(`importers:\n${match[1] ?? ""}`))["importers"]);
        for (const [key, importer] of Object.entries(entries)) {
            const dir = key === "." ? "" : key;
            const versions = importers.get(dir) ?? new Map<string, string>();
            importerVersions(importer, versions);
            importers.set(dir, versions);
        }
    }
    return importers;
};

// Keyed by the lockfile's size and mtime: it changes a few times a day and is read on every status check.
const lockCache = new Map<string, { readonly stamp: string; readonly versions: LockedVersions }>();

const lockedVersions = async (projectDir: string): Promise<LockedVersions> => {
    const lockfile = join(projectDir, "pnpm-lock.yaml");
    const stats = await stat(lockfile).catch(() => undefined);
    if (stats === undefined) {
        return new Map();
    }
    const stamp = `${stats.size}:${stats.mtimeMs}`;
    const cached = lockCache.get(lockfile);
    if (cached?.stamp === stamp) {
        return cached.versions;
    }
    // Removed since the stat: nothing to cache. Any other read failure propagates, never cached as "no versions".
    const text = await readFile(lockfile, "utf8").catch(undefinedIfMissing);
    if (text === undefined) {
        return new Map();
    }
    let versions: LockedVersions;
    try {
        versions = lockedVersionsOf(text);
    } catch (error) {
        // A lockfile mid-merge (conflict markers) says nothing about versions; resolvability still reports.
        if (!(error instanceof YAMLError)) {
            throw error;
        }
        versions = new Map();
    }
    lockCache.set(lockfile, { stamp, versions });
    return versions;
};

const installedVersion = async (dir: string): Promise<string | undefined> => {
    const manifest = await manifestAt(dir);
    return typeof manifest?.["version"] === "string" ? manifest["version"] : undefined;
};

// Only pnpm's lockfile is read. A dependency with no installed manifest is skipped: missing is the resolvability
// check's to report, and an optional one may be absent by design.
export const outdatedDependencies = async (projectDir: string): Promise<OutdatedDependency[]> => {
    const importers = await lockedVersions(projectDir);
    const pairs = [...importers].flatMap(([dir, versions]) => [...versions].map(([name, locked]) => ({ dir, name, locked })));
    const found = await Promise.all(
        pairs.slice(0, MAX_DEPENDENCIES).map(async ({ dir, name, locked }) => {
            const installed = await installedVersion(join(projectDir, dir, "node_modules", name));
            return installed === undefined || withoutBuild(installed) === withoutBuild(locked) ? undefined : { dir, name, installed, locked };
        }),
    );
    return found
        .filter((entry): entry is OutdatedDependency => entry !== undefined)
        .toSorted((left, right) => left.dir.localeCompare(right.dir) || left.name.localeCompare(right.name));
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

// Distinct names with both versions, embedded the same way; one bump across six importers is one entry.
export const outdatedSummary = (outdated: readonly OutdatedDependency[]): string => {
    const byName = new Map(outdated.map((entry) => [entry.name, `${entry.name} ${entry.installed} → ${entry.locked}`]));
    const shown = [...byName.values()].slice(0, SAMPLE).join(", ");
    return byName.size <= SAMPLE ? shown : `${shown} and ${byName.size - SAMPLE} more`;
};
