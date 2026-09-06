import { access, opendir, readFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { readWorkspaceManifests } from "./package-graph.js";

/* DEPENDENCY DRIFT, an installed tree that no longer satisfies the manifests above it.
 *
 * workspace-setup.ts answers "did an install ever happen here" by looking for node_modules, and that answer is
 * permanent: once the directory exists the project reads `ready` forever, however far its package.json moves
 * afterwards. An agent that adds a dependency and does not install it leaves exactly that state, the marker is
 * there, the import is not, and nothing in the system notices. The turn's own type-check then reports the new
 * import as broken, the model distrusts a diagnostic that was right, and the next conversation inherits it,
 * because an isolated turn overlays the MAIN checkout's node_modules as its lower layer (agents/isolation.ts).
 * One un-run install propagates to every turn that follows it.
 *
 * pnpm ships a guard for this, `verifyDepsBeforeRun`, and this repo's pnpm-workspace.yaml turns it OFF, with a
 * comment explaining why: the check is keyed to the workspace PATH, so a worktree whose node_modules are mirrored
 * from the main checkout is declared out of sync and reinstalls before every `pnpm run`. The guard cannot be
 * scoped to worktrees, so it had to go everywhere. This module is what replaces it, asked from OUTSIDE the
 * package manager, where the worktree layout is understood rather than mistaken for corruption.
 *
 * WHY RESOLVABILITY, AND NOT A LOCKFILE COMPARISON. The obvious check is to compare each manifest's declared
 * specifiers against pnpm-lock.yaml's `importers` block. Measured against this repository, it is wrong twice
 * over. It false-positives: `overrides` rewrite a recorded specifier (a manifest saying `catalog:` appears as
 * `4.4.3`), `autoInstallPeers` files peerDependencies under the importer's `dependencies`, and a named catalog
 * resolves differently from the default one: 15 phantom findings on a clean tree, every one of them pnpm lore
 * that would rot. And it false-negatives on the case that actually matters: this workspace has two packages that
 * ARE in the lockfile's importers and have no node_modules directory at all, so a lockfile comparison calls the
 * tree clean while an import from either one cannot resolve.
 *
 * So the question asked here is the one an import asks. Not "do the manifest and the lockfile agree", a fact
 * about two files, but "is the package this name refers to actually on disk". It reads no specifiers, so no
 * amount of catalog/override/peer machinery can confuse it, and it is true by construction: if this says a
 * dependency is missing, requiring it fails.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. A dependency whose installed VERSION no longer satisfies a widened range
 * is not reported. Reading that back out of the tree means resolving semver against every installed manifest,
 * which is a different order of cost, and the failure it describes is nothing like the same: the import still
 * resolves, the type-check still means something, and the tree is wrong rather than broken. This surface is for
 * broken. */

// Only the two blocks an install must materialize here. `optionalDependencies` are allowed to be absent, that
// is what optional means, and a platform-skipped binary would otherwise report as drift forever. peerDependencies
// are the CONSUMER's to provide: pnpm's autoInstallPeers happens to put them in the tree here, but a workspace
// without that setting would have every declared peer read as missing, which is a finding about the setting
// rather than about the install.
const INSTALLED_BLOCKS = ["dependencies", "devDependencies"] as const;

// Runaway guard, matching the shape every other walk in this directory uses. A manifest with more declared
// dependencies than this is not a project anyone installs; stopping is better than stalling the daemon.
const MAX_DEPENDENCIES = 20_000;

// One package that cannot resolve everything it declares. `dir` is relative to the PROJECT (the directory the
// install runs in), so "" is the project's own manifest and the rest are its workspace members.
export interface UnresolvedPackage {
    readonly dir: string;
    readonly names: readonly string[];
}

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

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

/* Does `name` resolve from `packageDir`? Two places, because the two node_modules LAYOUTS put it in different
 * ones: pnpm's isolated layout symlinks a package's direct dependencies into its own node_modules, while npm and
 * yarn hoist almost everything to the install root. Checking both means one predicate covers every manager the
 * setup recipes know about, and neither layout can report the other's tree as broken.
 *
 * Nothing walks the intermediate directories. A dependency resolving through some unrelated ancestor's tree is
 * not a dependency this project installed, it is the accident that makes a build work on one machine and fail
 * on the next, and calling it satisfied here is how this surface would learn to lie. */
const resolves = async (root: string, packageDir: string, name: string): Promise<boolean> =>
    (await exists(join(root, packageDir, "node_modules", name))) || (packageDir !== "" && (await exists(join(root, "node_modules", name))));

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

/* Every package under `projectDir` that declares a dependency which is not on disk, its own manifest included.
 *
 * The root manifest is checked separately from the workspace members rather than folded in, because
 * readWorkspaceManifests reads pnpm-workspace.yaml's globs and those never name the root, and a project that is
 * ONE package (no workspace file at all, which is most of what a user drops here) has no members, only a root.
 * Both shapes therefore have to arrive by different routes to land in the same list.
 *
 * Empty means every declared dependency resolves. It does NOT mean the versions are right, see the header. */
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

/* THE SAME QUESTION AT ONE FILE'S SCOPE, for the post-edit diagnostics hook, which has a path and no project.
 *
 * It walks up exactly as TypeScript's resolver does, and collects two things on the way: the first directory
 * owning a package.json (the package this file belongs to, whose manifest says what it may import) and the first
 * owning a node_modules (where an install put things). They are usually different directories in a monorepo, and
 * both are needed: the manifest names the dependencies, the install root is the hoisting fallback.
 *
 * `absent` and `installed` are kept apart rather than collapsed to a count, because they send a reader in
 * opposite directions, "nothing has been installed here" is a setup step, "this tree is behind" is a
 * reconciliation, and the notice the model receives has to say which.
 */
export type NearbyModules = { readonly kind: "absent" } | { readonly kind: "installed"; readonly missing: readonly string[] };

/* An install root is a node_modules with something IN it, and the emptiness check is not pedantry, it is the
 * one signature that tells an install apart from a mount point.
 *
 * An isolated turn's node_modules is overlaid INSIDE the turn's namespace (agents/worktrees.ts). This probe runs
 * in the daemon, outside it, where every one of those directories is present and empty. Accepting one as an
 * install root ended the walk at a tree holding nothing, so every declared name came back missing and the agent
 * was told its 57 installed, reachable dependencies were not installed, stapled to a wall of TS2307s from a
 * type-checker standing in the same blind spot (agent-diagnostics.ts), and to a sentence telling it not to trust
 * either. Walking PAST an empty one reaches a real install higher up, or the top of the tree, and the top is
 * already `absent`: no answer to be had from here, which is the truth.
 *
 * One entry decides it, so this opens the directory instead of listing it, a real node_modules holds thousands
 * of names and this runs on every edit. */
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
        packageDir ??= (await exists(join(dir, "package.json"))) ? dir : undefined;
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
    // An install root with no manifest above the file is a tree we cannot say anything about, every import it
    // makes is someone else's business. Not drift, and not worth a sentence.
    if (packageDir === undefined) {
        return { kind: "installed", missing: [] };
    }
    const manifest = await manifestAt(packageDir);
    const names = manifest === undefined ? [] : declaredNames(manifest);
    const missing = await Promise.all(
        names.map(async (name) =>
            (await exists(join(packageDir, "node_modules", name))) || (await exists(join(installRoot, "node_modules", name))) ? undefined : name,
        ),
    );
    return { kind: "installed", missing: missing.filter((name): name is string => name !== undefined) };
};

// How many missing names one sentence names before it stops. A project mid-migration can be missing hundreds,
// and the reader's decision, install, or don't, is already made by the third one.
const SAMPLE = 4;

/* The missing dependencies as one clause, for the surfaces that have a sentence rather than a table: the agent's
 * turn preamble and the post-edit diagnostics notice. Written to be embedded, so no leading capital and no
 * trailing period.
 *
 * DISTINCT names, though the count beside it is per package. One workspace library that six packages depend on
 * is six unresolved entries and one thing to say, and against this repository the undeduplicated version spent
 * three of its four slots repeating `@intentic/local-agent`, which is the whole sample telling the reader less
 * than one name would have. The count stays as it is: "15 not installed" is the size of the problem, and
 * collapsing that to the number of distinct packages would understate what the install has to do. */
export const unresolvedSummary = (unresolved: readonly UnresolvedPackage[]): string => {
    const names = [...new Set(unresolved.flatMap((entry) => entry.names))];
    const shown = names.slice(0, SAMPLE).join(", ");
    return names.length <= SAMPLE ? shown : `${shown} and ${names.length - SAMPLE} more`;
};
