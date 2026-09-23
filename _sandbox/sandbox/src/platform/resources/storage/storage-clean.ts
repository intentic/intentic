import { lstat, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { StorageCategoryId, StorageCleanResult } from "@intentic/sandbox-contract";
import { BROWSER_LOCK, type CleanCandidate, inFlight, planClean } from "./clean-plan.js";
import { namedByProgram, pnpmRunning, type RunningProgram } from "./running-programs.js";
import { categoryFolders, classifyStoragePath, locateStoragePath, removalOf, type StorageRoots } from "./storage-catalog.js";
import { walkTree } from "./storage-walk.js";

// Removes what one category holds. Its candidates are read fresh from disk, the plan decides, and each path is asked of
// the table once more right before it goes; a link is never followed, a category's own folder never removed, and
// nothing outside the sandbox's volumes is ever reached.

export interface CleanDeps {
    readonly roots: StorageRoots;
    readonly now: () => number;
    readonly programs: () => Promise<readonly RunningProgram[]>;
    // Hands a store to its own tool's prune; resolves whether that ran.
    readonly prune: (storeDir: string) => Promise<boolean>;
}

type Measured = Omit<CleanCandidate, "path">;

const codeOf = (error: unknown): string | undefined =>
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;

// A category folder's absolute path, without the trailing slash its rule keeps.
const folderPath = (roots: StorageRoots, root: keyof StorageRoots, prefix: string): string | undefined => {
    const base = roots[root];
    return base === undefined ? undefined : join(base, prefix.replace(/\/$/, ""));
};

const belongsTo = (category: StorageCategoryId, roots: StorageRoots, path: string): { readonly category: boolean; readonly unit: boolean } => {
    const located = locateStoragePath(roots, path);
    const classified = located === undefined ? undefined : classifyStoragePath(located.root, located.rel);
    return { category: classified?.category === category, unit: classified?.category === category && classified.unit };
};

// One entry as the disk has it now: a file by its own stats, a folder by everything below it.
const measure = async (path: string): Promise<Measured | undefined> => {
    const stats = await lstat(path).catch(() => undefined);
    if (stats === undefined) {
        return undefined;
    }
    if (!stats.isDirectory()) {
        const size = stats.isFile() ? stats.size : 0;
        return { folder: false, bytes: size, freeable: stats.nlink === 1 ? size : 0, newestMs: stats.mtimeMs, busy: inFlight(path) };
    }
    const tally = { folder: true, bytes: 0, freeable: 0, newestMs: 0, files: 0, busy: false };
    await walkTree(path, undefined, {
        folder: () => undefined,
        file: (file) => {
            tally.bytes += file.size;
            tally.freeable += file.nlink === 1 ? file.size : 0;
            tally.newestMs = Math.max(tally.newestMs, file.mtimeMs);
            tally.files += 1;
            tally.busy ||= inFlight(file.path);
        },
        link: (link) => {
            tally.busy ||= basename(link) === BROWSER_LOCK;
        },
    });
    // Aged by what it holds, as the scan ages it; a folder with nothing in it yet by its own clock, since it was made
    // for something about to be written.
    return { folder: true, bytes: tally.bytes, freeable: tally.freeable, newestMs: tally.files === 0 ? stats.mtimeMs : tally.newestMs, busy: tally.busy };
};

// Every path exactly one item deep below the category's folders, as the table reads it now; links are never entered.
const itemPaths = async (category: StorageCategoryId, roots: StorageRoots): Promise<string[]> => {
    const found = new Set<string>();
    for (const rule of categoryFolders(category)) {
        const folder = folderPath(roots, rule.root, rule.prefix);
        let level = folder === undefined || (await lstat(folder).catch(() => undefined))?.isDirectory() !== true ? [] : [folder];
        for (let depth = 0; depth < rule.depth; depth += 1) {
            const listed = await Promise.all(
                level.map(async (dir) =>
                    (await readdir(dir, { withFileTypes: true }).catch(() => []))
                        .filter((entry) => depth + 1 === rule.depth || entry.isDirectory())
                        .map((entry) => join(dir, entry.name)),
                ),
            );
            level = listed.flat();
        }
        for (const path of level.filter((candidate) => belongsTo(category, roots, candidate).unit)) {
            found.add(path);
        }
    }
    return [...found];
};

const itemCandidates = async (category: StorageCategoryId, deps: CleanDeps, running: readonly RunningProgram[]): Promise<CleanCandidate[]> => {
    const storeBusy = removalOf(category)?.unit === "prune" && pnpmRunning(running);
    const measured = await Promise.all(
        (await itemPaths(category, deps.roots)).map(async (path): Promise<CleanCandidate[]> => {
            const facts = await measure(path);
            return facts === undefined ? [] : [{ ...facts, path, busy: facts.busy || storeBusy || namedByProgram(running, path) }];
        }),
    );
    return measured.flat();
};

// Every file of the category below its folders; a folder another category claims is not entered.
const fileCandidates = async (category: StorageCategoryId, roots: StorageRoots): Promise<CleanCandidate[]> => {
    const found: CleanCandidate[] = [];
    for (const rule of categoryFolders(category)) {
        const folder = folderPath(roots, rule.root, rule.prefix);
        if (folder === undefined) {
            continue;
        }
        await walkTree(folder, undefined, {
            folder: (path) => (belongsTo(category, roots, path).category ? undefined : "skip"),
            file: (file) =>
                found.push({
                    path: file.path,
                    folder: false,
                    bytes: file.size,
                    freeable: file.nlink === 1 ? file.size : 0,
                    newestMs: file.mtimeMs,
                    busy: inFlight(file.path),
                }),
        });
    }
    return found;
};

// The table's answer again, at the moment of removal, and a parent with no link in it: a folder swapped for a link
// since the listing would otherwise lead the removal somewhere else.
const stillRemovable = async (category: StorageCategoryId, target: CleanCandidate, deps: CleanDeps): Promise<boolean> => {
    if (planClean(category, [target], deps.roots, deps.now()).targets.length !== 1) {
        return false;
    }
    const parent = dirname(target.path);
    return (await realpath(parent).catch(() => undefined)) === parent;
};

// Folders the removals emptied, deepest first, stopping at the category's own folders, which writers expect to find.
const pruneEmptied = async (removed: readonly string[], keep: ReadonlySet<string>): Promise<void> => {
    const emptied = new Set<string>();
    for (const path of removed) {
        for (let dir = dirname(path); !keep.has(dir) && dir !== dirname(dir); dir = dirname(dir)) {
            emptied.add(dir);
        }
    }
    for (const dir of [...emptied].toSorted((left, right) => right.length - left.length)) {
        await rmdir(dir).catch(() => undefined);
    }
};

const pruneStores = async (targets: readonly CleanCandidate[], deps: CleanDeps, result: StorageCleanResult): Promise<StorageCleanResult> => {
    let { freedBytes, removed, failed } = result;
    for (const target of targets) {
        if (!(await stillRemovable(result.category, target, deps))) {
            continue;
        }
        const ran = await deps.prune(target.path);
        const after = await measure(target.path);
        freedBytes += Math.max(0, target.freeable - (after?.freeable ?? 0));
        removed += ran ? 1 : 0;
        failed += ran ? 0 : 1;
    }
    return { ...result, freedBytes, removed, failed };
};

// Removes each target the table still gives this category, a link as a link; one that vanished meanwhile is no one's.
const removeTargets = async (
    targets: readonly CleanCandidate[],
    deps: CleanDeps,
    result: StorageCleanResult,
): Promise<{ readonly result: StorageCleanResult; readonly gone: readonly string[] }> => {
    let { freedBytes, removed, kept, failed } = result;
    const gone: string[] = [];
    for (const target of targets) {
        if (!(await stillRemovable(result.category, target, deps))) {
            kept += 1;
            continue;
        }
        const outcome = await rm(target.path, { recursive: target.folder, force: false }).then(
            () => "removed" as const,
            (error: unknown) => (codeOf(error) === "ENOENT" ? ("vanished" as const) : ("failed" as const)),
        );
        freedBytes += outcome === "removed" ? target.freeable : 0;
        removed += outcome === "removed" ? 1 : 0;
        failed += outcome === "failed" ? 1 : 0;
        gone.push(...(outcome === "removed" ? [target.path] : []));
    }
    return { result: { ...result, freedBytes, removed, kept, failed }, gone };
};

export const cleanCategory = async (category: StorageCategoryId, deps: CleanDeps): Promise<StorageCleanResult> => {
    const removal = removalOf(category)?.unit;
    const running = await deps.programs();
    const candidates = removal === "file" ? await fileCandidates(category, deps.roots) : await itemCandidates(category, deps, running);
    const plan = planClean(category, candidates, deps.roots, deps.now());
    const planned: StorageCleanResult = { category, freedBytes: 0, removed: 0, kept: plan.kept.length, failed: 0 };
    if (removal === "prune") {
        return pruneStores(plan.targets, deps, planned);
    }
    const { result, gone } = await removeTargets(plan.targets, deps, planned);
    if (removal === "file") {
        const folders = categoryFolders(category).map((rule) => folderPath(deps.roots, rule.root, rule.prefix));
        await pruneEmptied(gone, new Set(folders.filter((folder): folder is string => folder !== undefined)));
    }
    return result;
};
