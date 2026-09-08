import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceDepEdge, WorkspaceDepType, WorkspaceGraph, WorkspacePackage } from "@intentic/sandbox-contract";
import { parse } from "yaml";

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

export const readWorkspaceManifests = (repoDir: string): WorkspaceManifest[] => {
    const workspaceFile = join(repoDir, "pnpm-workspace.yaml");
    // Every caller must answer for any repo, monorepo or not: no workspace file just means no packages.
    if (!existsSync(workspaceFile)) {
        return [];
    }
    const globs = (parse(readFileSync(workspaceFile, "utf8")) as { packages?: string[] } | undefined)?.packages ?? [];
    const excluded = negated(globs);
    const found: WorkspaceManifest[] = [];
    const seen = new Set<string>();
    for (const glob of globs.filter((entry) => !entry.startsWith("!"))) {
        for (const dir of expandGlob(repoDir, glob).filter((candidate) => !excluded.has(candidate))) {
            // A dir without a parseable, named package.json isn't a workspace package (matches pnpm's own view).
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
