import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { pathExists } from "@intentic/base/fs";
import type {
    WorkspaceComponent,
    WorkspaceDepEdge,
    WorkspaceDepType,
    WorkspaceGraph,
    WorkspacePackage,
} from "@intentic/sandbox-contract/schemas/workspace/workspace-graph";
import { parse } from "yaml";
import { parseJsonOr } from "@intentic/base/json";

// Workspace package dependency graph of a pnpm monorepo, read straight from the filesystem: pnpm-workspace.yaml's globs
// name package dirs, each package.json is a node, its dependency blocks are edges. Edges match by the dep name being a
// workspace package; a `workspace:` protocol check would miss catalog:/version-pinned intra-workspace refs.

type PackageManifest = { name?: unknown } & Record<string, unknown>;

const DEP_BLOCKS: readonly (readonly [string, WorkspaceDepType])[] = [
    ["dependencies", "prod"],
    ["devDependencies", "dev"],
    ["peerDependencies", "peer"],
];

// Expands one pnpm glob into repo-relative dirs; a literal dir or trailing `/*` only, `**` skipped. Negations are the
// caller's: a `!dir` line must be read with the line it excludes from.
const expandGlob = (repoDir: string, glob: string): string[] => {
    if (glob.includes("**")) {
        return [];
    }
    if (!glob.endsWith("/*")) {
        return existsSync(join(repoDir, glob, "package.json")) ? [glob] : [];
    }
    const prefix = glob.slice(0, -2);
    const parent = join(repoDir, prefix);
    if (!existsSync(parent)) {
        return [];
    }
    return readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${prefix}/${entry.name}`);
};

// expandGlob's reading without blocking: a missing parent expands to nothing.
const expandGlobAsync = async (repoDir: string, glob: string): Promise<string[]> => {
    if (glob.includes("**")) {
        return [];
    }
    if (!glob.endsWith("/*")) {
        return (await pathExists(join(repoDir, glob, "package.json"))) ? [glob] : [];
    }
    const prefix = glob.slice(0, -2);
    const entries = (await readdir(join(repoDir, prefix), { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];
    return entries.filter((entry) => entry.isDirectory()).map((entry) => `${prefix}/${entry.name}`);
};

// A `!dir` line excludes a dir pnpm itself does not install (this repo's two store shells, built by Xcode/Bubblewrap).
// Exact paths only: a glob negation is unknown here and would be wrongly kept.
const negated = (globs: readonly string[]): Set<string> =>
    new Set(globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1).replace(/\/+$/, "")));

// One workspace package as its manifest declares it, with its dir. Exported since other readers need each package's
// engines and deps too; two glob-expanders over one file would risk disagreeing about what a package is.
export interface WorkspaceManifest {
    readonly dir: string;
    readonly name: string;
    readonly manifest: PackageManifest;
}

const WORKSPACE_FILE = "pnpm-workspace.yaml";
const globsOf = (workspaceFile: string): string[] => (parse(workspaceFile) as { packages?: string[] } | undefined)?.packages ?? [];

// Candidate package dirs in glob order, the `!dir` lines taken out; the sync and async readers differ only in their IO.
const packageDirs = (globs: readonly string[], expand: (glob: string) => string[]): string[] => {
    const excluded = negated(globs);
    return globs.filter((entry) => !entry.startsWith("!")).flatMap((glob) => expand(glob).filter((candidate) => !excluded.has(candidate)));
};

// A dir without a readable, parseable, named package.json isn't a workspace package (matches pnpm's own view); a name
// two dirs claim stays with the first. `read` gives the dir at `index` its package.json text, throwing where it can't.
const namedPackages = (dirs: readonly string[], read: (dir: string, index: number) => string): WorkspaceManifest[] => {
    const found: WorkspaceManifest[] = [];
    const seen = new Set<string>();
    for (const [index, dir] of dirs.entries()) {
        let pkg: PackageManifest;
        try {
            pkg = JSON.parse(read(dir, index)) as PackageManifest;
        } catch {
            continue;
        }
        if (typeof pkg.name !== "string" || seen.has(pkg.name)) {
            continue;
        }
        seen.add(pkg.name);
        found.push({ dir, name: pkg.name, manifest: pkg });
    }
    return found;
};

export const readWorkspaceManifests = (repoDir: string): WorkspaceManifest[] => {
    const workspaceFile = join(repoDir, WORKSPACE_FILE);
    // Every caller must answer for any repo, monorepo or not: no workspace file just means no packages.
    if (!existsSync(workspaceFile)) {
        return [];
    }
    const dirs = packageDirs(globsOf(readFileSync(workspaceFile, "utf8")), (glob) => expandGlob(repoDir, glob));
    return namedPackages(dirs, (dir) => readFileSync(join(repoDir, dir, "package.json"), "utf8"));
};

// readWorkspaceManifests off the event loop, for a route polled per repo (the chores rail): the sync walk of this
// monorepo's manifests measured 2.3 s of the daemon's main thread at boot.
export const readWorkspaceManifestsAsync = async (repoDir: string): Promise<WorkspaceManifest[]> => {
    const workspaceFile = await readFile(join(repoDir, WORKSPACE_FILE), "utf8").catch(undefinedIfMissing);
    if (workspaceFile === undefined) {
        return [];
    }
    const globs = globsOf(workspaceFile);
    // Each glob expanded up front, so the shared filter sees the same lists the sync reader builds one at a time.
    const included = globs.filter((glob) => !glob.startsWith("!"));
    const expanded = new Map(await Promise.all(included.map(async (glob) => [glob, await expandGlobAsync(repoDir, glob)] as const)));
    const dirs = packageDirs(globs, (glob) => expanded.get(glob) ?? []);
    const reads = await Promise.allSettled(dirs.map((dir) => readFile(join(repoDir, dir, "package.json"), "utf8")));
    return namedPackages(dirs, (_dir, index) => {
        const read = reads[index]!;
        if (read.status === "rejected") {
            throw read.reason;
        }
        return read.value;
    });
};

// The repository's map, docs/architecture/repo.json as the documentation extension writes it: its components in order,
// each with the package directories it holds. Undefined without one, or with one that does not read as a map.
const MAP_FILE = "docs/architecture/repo.json";
interface RepoMap {
    readonly components: readonly WorkspaceComponent[];
    readonly componentOf: ReadonlyMap<string, string>;
}
const readRepoMap = (repoDir: string): RepoMap | undefined => {
    let text: string;
    try {
        text = readFileSync(join(repoDir, MAP_FILE), "utf8");
    } catch (error) {
        return undefinedIfMissing(error);
    }
    // A map caught mid-write draws the graph by folder, as a repository without docs gets it.
    const parsed = parseJsonOr(text, undefined);
    const listed = (parsed as { components?: unknown } | null | undefined)?.components;
    if (!Array.isArray(listed)) {
        return undefined;
    }
    const components: WorkspaceComponent[] = [];
    const componentOf = new Map<string, string>();
    for (const entry of listed as unknown[]) {
        const { id, name, accent, packages } = (entry ?? {}) as Record<string, unknown>;
        if (typeof id !== "string" || typeof name !== "string") {
            continue;
        }
        components.push({ id, name, ...(typeof accent === "string" ? { accent } : {}) });
        for (const listedDir of Array.isArray(packages) ? packages : []) {
            const dir = typeof listedDir === "string" ? listedDir.replace(/\/+$/, "") : undefined;
            // A package two components claim stays with the first.
            if (dir !== undefined && !componentOf.has(dir)) {
                componentOf.set(dir, id);
            }
        }
    }
    return components.length > 0 ? { components, componentOf } : undefined;
};

export const readPackageGraph = (repoDir: string, found: readonly WorkspaceManifest[] = readWorkspaceManifests(repoDir)): WorkspaceGraph => {
    const map = readRepoMap(repoDir);
    const packages: WorkspacePackage[] = found.map(({ name, dir }) => {
        const component = map?.componentOf.get(dir);
        return { name, dir, group: dir.split("/")[0] ?? dir, ...(component !== undefined ? { component } : {}) };
    });
    const manifests = new Map(found.map(({ name, manifest }) => [name, manifest]));

    const edges: WorkspaceDepEdge[] = [];
    for (const { name } of packages) {
        const manifest = manifests.get(name);
        for (const [block, type] of DEP_BLOCKS) {
            const deps = manifest?.[block];
            if (typeof deps !== "object" || deps === null) {
                continue;
            }
            for (const dep of Object.keys(deps)) {
                if (dep !== name && manifests.has(dep)) {
                    edges.push({ from: name, to: dep, type });
                }
            }
        }
    }
    return { packages, edges, ...(map !== undefined ? { components: [...map.components] } : {}) };
};
