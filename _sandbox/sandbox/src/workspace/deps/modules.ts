import type { Dirent } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { WorkspaceModule } from "@intentic/sandbox-contract/schemas/git/git";
import { walkDirs } from "../layout/dir-walk.js";
import { hasGitEntry } from "../layout/repo-discovery.js";
import { readTextIfExists } from "@intentic/base/fs";
import { parseJsonOr } from "@intentic/base/json";

// Modules of a repo: every directory with a self-naming manifest (package.json, or a Rust crate's Cargo.toml), as
// repo-relative dirs, used to group changed files in review panels. A filesystem walk, not package-graph.ts's
// pnpm-workspace globs: grouping is about where a file lives, not a dependency edge. Bounded, and prunes nested repos too, which carry their own {repo} id.

// packages/<group>/<pkg> is the deepest layout worth walking; past that isn't what anyone means by module.
const MAX_DEPTH = 3;
// Runaway guard for a pathological tree: stop the scan rather than stall the daemon.
const MAX_DIRS = 5_000;

// Only the self-declared name is read; a manifest that names nothing (or a non-string) is no module.
const NAME = z.string().min(1).optional().catch(undefined);
const PackageJsonSchema = z.object({ name: NAME });
// A crate names itself in [package]. A virtual workspace manifest (only [workspace]) names nothing, so a Cargo workspace
// root is not a module of its own, the same as a pnpm root without a name.
const CargoTomlSchema = z.object({ package: z.object({ name: NAME }).optional().catch(undefined) });

const packageJsonName = (text: string): string | undefined => PackageJsonSchema.safeParse(parseJsonOr(text, undefined)).data?.name;

const cargoTomlName = (text: string): string | undefined => {
    try {
        return CargoTomlSchema.safeParse(parseToml(text)).data?.package?.name;
        // allow(silent-catch): A Cargo.toml mid-edit names no crate this grouping can trust.
    } catch {
        return undefined;
    }
};

// Read in this order, first name wins: a dir holding both (a napi-rs crate) is the npm package people import.
const MANIFESTS = [
    { file: "package.json", nameIn: packageJsonName },
    { file: "Cargo.toml", nameIn: cargoTomlName },
] as const;

// The name a directory's manifest declares; undefined when there's no manifest, it doesn't parse, or it names nothing.
const manifestName = async (dir: string): Promise<string | undefined> => {
    for (const manifest of MANIFESTS) {
        const text = await readTextIfExists(join(dir, manifest.file));
        const name = text === undefined ? undefined : manifest.nameIn(text);
        if (name !== undefined) {
            return name;
        }
    }
    return undefined;
};

// Cargo's build output: `target/package/<crate>-<version>/Cargo.toml` is a packaged copy of a crate, not a module.
// Only pruned beside a Cargo manifest, since `target` is an ordinary name anywhere else.
const isCargoTarget = (subdir: { readonly name: string }, entries: readonly Dirent[]): boolean =>
    subdir.name === "target" && entries.some((entry) => entry.isFile() && (entry.name === "Cargo.toml" || entry.name === "Cargo.lock"));

export const readModules = async (repoDir: string): Promise<WorkspaceModule[]> => {
    const modules: WorkspaceModule[] = [];
    await walkDirs(repoDir, { maxDepth: MAX_DEPTH, maxDirs: MAX_DIRS }, async (_dir, entries, subdirs) => {
        const candidates = subdirs.filter((subdir) => !isCargoTarget(subdir, entries));
        const nested = await Promise.all(candidates.map((subdir) => hasGitEntry(subdir.path)));
        const inside = candidates.filter((_, index) => !nested[index]);
        for (const subdir of inside) {
            const name = await manifestName(subdir.path);
            if (name !== undefined) {
                modules.push({ dir: subdir.rel, name });
            }
        }
        // Keeps walking through a module: a package holding packages is ordinary, not a boundary.
        return inside;
    });
    // A one-package repo declares itself at its root, read only when nothing under it claimed a file first.
    const own = modules.length === 0 ? await manifestName(repoDir) : undefined;
    return own === undefined ? modules : [{ dir: "", name: own }];
};
