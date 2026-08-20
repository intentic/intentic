import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceDepEdge, WorkspaceDepType, WorkspaceGraph, WorkspacePackage } from "@intentic/sandbox-contract";
import { parse } from "yaml";

// The workspace package dependency graph of a pnpm monorepo, read straight from the filesystem:
// pnpm-workspace.yaml's `packages` globs name the package dirs, each dir's package.json contributes a node,
// and its dependency blocks contribute edges to other workspace packages. Edges match by the dep NAME being a
// workspace package, a `workspace:` protocol check would miss catalog:/version-pinned intra-workspace refs.

type PackageManifest = { name?: unknown } & Record<string, unknown>;

const DEP_BLOCKS: readonly (readonly [string, WorkspaceDepType])[] = [
    ["dependencies", "prod"],
    ["devDependencies", "dev"],
    ["peerDependencies", "peer"],
];

// Expand one pnpm packages glob into repo-relative package dirs. Only the common shapes are supported: a
// literal dir and a single trailing `/*` segment (readdir of the prefix). `!negations` and `**` are skipped,
// the monorepos this product manages use flat `_dir/*` globs.
const expandGlob = (repoDir: string, glob: string): string[] => {
    if (glob.startsWith("!") || glob.includes("**")) {
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

// One workspace package as its manifest declares it, with the dir it was found in. Exported because the graph is
// not the only reader of these files, the maintenance surface's signals need each package's engines and
// dependency names, and two independent glob-expanders over one pnpm-workspace.yaml would be two chances to
// disagree about what a package even is.
export interface WorkspaceManifest {
    readonly dir: string;
    readonly name: string;
    readonly manifest: PackageManifest;
}

export const readWorkspaceManifests = (repoDir: string): WorkspaceManifest[] => {
    const workspaceFile = join(repoDir, "pnpm-workspace.yaml");
    // Every caller must answer for any repo, monorepo or not, no workspace file simply means no packages.
    if (!existsSync(workspaceFile)) {
        return [];
    }
    const globs = (parse(readFileSync(workspaceFile, "utf8")) as { packages?: string[] } | undefined)?.packages ?? [];
    const found: WorkspaceManifest[] = [];
    const seen = new Set<string>();
    for (const glob of globs) {
        for (const dir of expandGlob(repoDir, glob)) {
            // A dir without a parseable, named package.json isn't a workspace package (matches pnpm's view).
            let pkg: PackageManifest;
            try {
                pkg = JSON.parse(readFileSync(join(repoDir, dir, "package.json"), "utf8")) as PackageManifest;
            } catch {
                continue;
            }
            if (typeof pkg.name !== "string" || seen.has(pkg.name)) {
                continue;
            }
            seen.add(pkg.name);
            found.push({ dir, name: pkg.name, manifest: pkg });
        }
    }
    return found;
};

export const readPackageGraph = (repoDir: string): WorkspaceGraph => {
    const found = readWorkspaceManifests(repoDir);
    const packages: WorkspacePackage[] = found.map(({ name, dir }) => ({ name, dir, group: dir.split("/")[0] ?? dir }));
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
    return { packages, edges };
};
