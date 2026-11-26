import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { pathExists } from "@intentic/base/fs";
import { parse } from "yaml";

// The workspace packages of a pnpm monorepo, read straight from the filesystem: pnpm-workspace.yaml's globs name package
// dirs, and each dir's package.json names the package and declares its engines and dependencies. Read for dependency
// drift and the chores rail. The package graph the Dependencies view draws is the repo-apps extension's
// (_extensions/repo-apps/src/server), which reads the same file with a reader of its own, since an extension reaches
// only the SDK and @intentic/base.

type PackageManifest = { name?: unknown } & Record<string, unknown>;

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
        .map((entry) => `${prefix}/${entry.name}`)
        .toSorted();
};

// expandGlob's reading without blocking: a missing parent expands to nothing. Both sort by name: readdir's order is the
// filesystem's, so without it which dir keeps a name two claim, and the order every reader lists, would vary by host.
const expandGlobAsync = async (repoDir: string, glob: string): Promise<string[]> => {
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

// A `!dir` line excludes a dir pnpm itself does not install (this repo's two store shells, built by Xcode/Bubblewrap).
// Exact paths only: a glob negation is unknown here and would be wrongly kept.
const negated = (globs: readonly string[]): Set<string> =>
    new Set(globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1).replace(/\/+$/, "")));

// One workspace package as its manifest declares it, with its dir. One reader for every daemon consumer: two
// glob-expanders over one file would risk disagreeing about what a package is.
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
