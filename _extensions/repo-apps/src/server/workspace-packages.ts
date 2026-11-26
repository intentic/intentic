import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { pathExists } from "@intentic/base/fs";
import { parseJsonWith } from "@intentic/base/json";
import type {
    WorkspaceComponent,
    WorkspaceDepEdge,
    WorkspaceDepType,
    WorkspaceGraph,
    WorkspacePackage,
} from "@intentic/sandbox-contract/schemas/workspace/workspace-graph";
import { parse } from "yaml";
import { z } from "zod";

// Workspace package dependency graph of a pnpm monorepo, read straight from the filesystem: pnpm-workspace.yaml's globs
// name package dirs, each package.json is a node, its dependency blocks are edges. Edges match by the dep name being a
// workspace package; a `workspace:` protocol check would miss catalog:/version-pinned intra-workspace refs.
//
// The daemon reads the same file for its own ends (dependency drift, the chores rail) in its workspace-manifests.ts; an
// extension reaches only the SDK and @intentic/base, so this is a reading of its own, tested on the cases the daemon's
// reader is (workspace-packages.integration.test.ts). Every read is asynchronous: the backend host is one process every backend
// shares, and the synchronous walk of a large monorepo's manifests measured seconds of a main thread.

// What a package.json is read for. A block that is not an object reads as absent, as pnpm skips it; a manifest without a
// name is no workspace package.
const BlockSchema = z.record(z.string(), z.unknown()).optional().catch(undefined);
const PackageManifestSchema = z.object({
    name: z.string(),
    dependencies: BlockSchema,
    devDependencies: BlockSchema,
    peerDependencies: BlockSchema,
    scripts: BlockSchema,
    bin: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().catch(undefined),
});
export type PackageManifest = z.infer<typeof PackageManifestSchema>;

const DEP_BLOCKS: readonly (readonly ["dependencies" | "devDependencies" | "peerDependencies", WorkspaceDepType])[] = [
    ["dependencies", "prod"],
    ["devDependencies", "dev"],
    ["peerDependencies", "peer"],
];

// Expands one pnpm glob into repo-relative dirs; a literal dir or trailing `/*` only, `**` skipped, a missing parent
// nothing. Sorted by name: readdir's order is the filesystem's, so without it which dir keeps a name two claim, and the
// order every reader lists, would vary by host. Negations are the caller's: a `!dir` line must be read with the line it
// excludes from.
const expandGlob = async (repoDir: string, glob: string): Promise<string[]> => {
    if (glob.includes("**")) {
        return [];
    }
    if (!glob.endsWith("/*")) {
        return (await pathExists(join(repoDir, glob, "package.json"))) ? [glob] : [];
    }
    const prefix = glob.slice(0, -2);
    const entries = (await readdir(join(repoDir, prefix), { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${prefix}/${entry.name}`)
        .toSorted();
};

// A `!dir` line excludes a dir pnpm itself does not install (a store shell built by Xcode or Bubblewrap). Exact paths
// only: a glob negation is unknown here and would be wrongly kept.
const negated = (globs: readonly string[]): Set<string> =>
    new Set(globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1).replace(/\/+$/, "")));

// One workspace package as its manifest declares it, with its dir.
export interface WorkspaceManifest {
    readonly dir: string;
    readonly name: string;
    readonly manifest: PackageManifest;
}

const WORKSPACE_FILE = "pnpm-workspace.yaml";
const WorkspaceFileSchema = z.object({ packages: z.array(z.string()).optional().catch(undefined) }).nullish();
const globsOf = (workspaceFile: string): string[] => WorkspaceFileSchema.safeParse(parse(workspaceFile)).data?.packages ?? [];

// A dir without a readable, parseable, named package.json isn't a workspace package (matches pnpm's own view); a name
// two dirs claim stays with the first.
const namedPackages = (dirs: readonly string[], reads: readonly PromiseSettledResult<string>[]): WorkspaceManifest[] => {
    const found: WorkspaceManifest[] = [];
    const seen = new Set<string>();
    for (const [index, dir] of dirs.entries()) {
        const read = reads[index];
        const manifest = read?.status === "fulfilled" ? parseJsonWith(read.value, PackageManifestSchema) : undefined;
        if (manifest === undefined || seen.has(manifest.name)) {
            continue;
        }
        seen.add(manifest.name);
        found.push({ dir, name: manifest.name, manifest });
    }
    return found;
};

/** The repository's workspace packages in glob order; none for a repository without pnpm-workspace.yaml. */
export const readWorkspaceManifests = async (repoDir: string): Promise<WorkspaceManifest[]> => {
    const workspaceFile = await readFile(join(repoDir, WORKSPACE_FILE), "utf8").catch(undefinedIfMissing);
    if (workspaceFile === undefined) {
        return [];
    }
    const globs = globsOf(workspaceFile);
    const excluded = negated(globs);
    const expanded = await Promise.all(globs.filter((glob) => !glob.startsWith("!")).map((glob) => expandGlob(repoDir, glob)));
    const dirs = expanded.flat().filter((candidate) => !excluded.has(candidate));
    const reads = await Promise.allSettled(dirs.map((dir) => readFile(join(repoDir, dir, "package.json"), "utf8")));
    return namedPackages(dirs, reads);
};

// The repository's map, docs/architecture/repo.json as the documentation extension writes it: its components in order,
// each with the package directories it holds. Undefined without one, or with one that does not read as a map; a map
// caught mid-write draws the graph by folder, as a repository without docs gets it.
const MAP_FILE = "docs/architecture/repo.json";
const RepoMapFileSchema = z.object({ components: z.array(z.unknown()) });
// A component that does not name itself in full is skipped, and so is what it lists; a listed dir that is not a string
// is skipped alone.
const MapComponentSchema = z.object({
    id: z.string(),
    name: z.string(),
    accent: z.string().optional().catch(undefined),
    packages: z
        .array(z.string().optional().catch(undefined))
        .optional()
        .catch(undefined)
        .transform((dirs) => (dirs ?? []).flatMap((dir) => (dir === undefined ? [] : [dir.replace(/\/+$/, "")]))),
});

interface RepoMap {
    readonly components: readonly WorkspaceComponent[];
    readonly componentOf: ReadonlyMap<string, string>;
}

const readRepoMap = async (repoDir: string): Promise<RepoMap | undefined> => {
    const text = await readFile(join(repoDir, MAP_FILE), "utf8").catch(undefinedIfMissing);
    const listed = text === undefined ? undefined : parseJsonWith(text, RepoMapFileSchema)?.components;
    const components: WorkspaceComponent[] = [];
    const componentOf = new Map<string, string>();
    for (const entry of listed ?? []) {
        const parsed = MapComponentSchema.safeParse(entry);
        if (!parsed.success) {
            continue;
        }
        const { id, name, accent, packages } = parsed.data;
        components.push(accent === undefined ? { id, name } : { id, name, accent });
        // A package two components claim stays with the first.
        for (const dir of packages.filter((listedDir) => !componentOf.has(listedDir))) {
            componentOf.set(dir, id);
        }
    }
    return components.length > 0 ? { components, componentOf } : undefined;
};

// Each package's declared edges to its siblings, typed by the block that declared them.
const declaredEdges = (found: readonly WorkspaceManifest[]): WorkspaceDepEdge[] => {
    const names = new Set(found.map(({ name }) => name));
    return found.flatMap(({ name, manifest }) =>
        DEP_BLOCKS.flatMap(([block, type]) =>
            Object.keys(manifest[block] ?? {})
                .filter((dep) => dep !== name && names.has(dep))
                .map((to) => ({ from: name, to, type })),
        ),
    );
};

/** The declared graph: every package, placed in the repository map's component when there is one, and its edges. */
export const readPackageGraph = async (repoDir: string, found: readonly WorkspaceManifest[]): Promise<WorkspaceGraph> => {
    const map = await readRepoMap(repoDir);
    const packages: WorkspacePackage[] = found.map(({ name, dir }) => {
        const placed: WorkspacePackage = { name, dir, group: dir.split("/")[0] ?? dir };
        const component = map?.componentOf.get(dir);
        return component === undefined ? placed : { ...placed, component };
    });
    const graph: WorkspaceGraph = { packages, edges: declaredEdges(found) };
    return map === undefined ? graph : { ...graph, components: [...map.components] };
};
