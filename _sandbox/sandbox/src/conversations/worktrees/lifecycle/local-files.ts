import { lstat, mkdir, open, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { GitRunner } from "@intentic/base/git";
import { pathExists } from "@intentic/base/fs";
import type { Logger } from "pino";
import { gitDirOf } from "../../../store/git/git-dir.js";
import { undefinedIfMissing } from "@intentic/base/errors";
import { MIRRORED_DIRS } from "@intentic/constants/mirror-roots";

/* WHAT A CHECKOUT HOLDS THAT ITS BRANCH NEVER WILL (2026-11-24). Retiring a checkout commits what `git status` shows and
 * then runs `git worktree remove --force`, which deletes every git-ignored file with it: an `.env.local` an agent wrote,
 * a dev database, a local config. Those exist nowhere else. So before the removal, the ignored files are listed, the
 * ones a fresh checkout regenerates (dependency and build output, caches) and the ones identical to the main checkout's
 * copy (a `.worktreeinclude` copy left unchanged, worktree-include.ts) are passed over, and what is left is moved into
 * the history volume's trash, where the Storage card lists it and the trash sweep clears it once it has sat its while
 * (system/resources/storage/trash-sweep.ts). The scan is bounded by time and by entries: what it had no time to judge
 * is set aside whole rather than lost, and the manifest beside it says the scan was cut short.
 * The idea is Orca's (src/main/git/worktrees/removal/worktree-at-risk-local-files.ts); Orca warns and asks, while a
 * retire here runs unattended, so nothing asks and the files are kept instead. */

// Dependency, build and cache output a fresh checkout regenerates, plus whatever the turn's isolation mirrors in from
// the main tree (isolation.ts MIRRORED_DIRS): those are links or overlay mount points, never the conversation's own.
export const REGENERABLE_DIRS: ReadonlySet<string> = new Set([
    ...MIRRORED_DIRS,
    "bower_components",
    ".pnpm-store",
    ".yarn",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".angular",
    ".expo",
    ".output",
    ".vite",
    ".turbo",
    ".parcel-cache",
    ".cache",
    "target",
    ".gradle",
    ".dart_tool",
    "Pods",
    "vendor",
    "_build",
    ".terraform",
    "DerivedData",
    ".build",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    "coverage",
    ".nyc_output",
]);

const DISPOSABLE_FILES: ReadonlySet<string> = new Set([".DS_Store", "Thumbs.db", "desktop.ini", ".eslintcache"]);
const DISPOSABLE_SUFFIXES = [".pyc", ".pyo", ".tsbuildinfo", ".log"];

const disposable = (name: string): boolean => DISPOSABLE_FILES.has(name) || DISPOSABLE_SUFFIXES.some((suffix) => name.endsWith(suffix));

export interface ScanLimits {
    // Wall-clock budget for the whole scan; what is not judged by then is kept whole.
    readonly deadlineMs: number;
    // Directory entries walked and files compared.
    readonly maxEntries: number;
    // Bytes read for comparisons; a file past `maxFileBytes` is kept without being read.
    readonly maxCompareBytes: number;
    readonly maxFileBytes: number;
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = { deadlineMs: 8_000, maxEntries: 5_000, maxCompareBytes: 64 * 1024 * 1024, maxFileBytes: 8 * 1024 * 1024 };

export interface LocalFilesScan {
    // Checkout-relative paths to keep; a directory (ending in `/`) is kept whole because the scan ran out before judging it.
    readonly atRisk: readonly string[];
    // False when a limit cut the scan short, so some entries were kept whole without being judged.
    readonly complete: boolean;
}

interface Budget {
    entries: number;
    bytes: number;
    readonly until: number;
    readonly limits: ScanLimits;
    readonly now: () => number;
}

const spent = (budget: Budget): boolean => budget.entries >= budget.limits.maxEntries || budget.now() >= budget.until;

// Whether the main checkout holds the same bytes at the same path. Anything unreadable, larger than the budget allows or
// of another kind reads as different: the file is kept.
const sameAsMain = async (file: string, mainFile: string, size: number, budget: Budget): Promise<boolean> => {
    const theirs = await lstat(mainFile).catch(undefinedIfMissing);
    if (theirs?.isFile() !== true || theirs.size !== size) {
        return false;
    }
    if (size > budget.limits.maxFileBytes || budget.bytes + size * 2 > budget.limits.maxCompareBytes) {
        return false;
    }
    budget.bytes += size * 2;
    const [mine, main] = await Promise.all([readWhole(file), readWhole(mainFile)]);
    return mine !== undefined && main !== undefined && mine.equals(main);
};

const readWhole = async (path: string): Promise<Buffer | undefined> => {
    // allow(silent-catch): a file that cannot be opened reads as different from main's, so it is kept, never lost.
    const handle = await open(path, "r").catch(() => undefined);
    if (handle === undefined) {
        return undefined;
    }
    try {
        return await handle.readFile();
    } finally {
        await handle.close();
    }
};

// One entry of the checkout, judged: the files under it to keep, or the entry whole when the budget ran out mid-way.
const judge = async (worktree: string, main: string, rel: string, budget: Budget, kept: string[]): Promise<"judged" | "cut"> => {
    if (spent(budget)) {
        return "cut";
    }
    budget.entries += 1;
    const path = join(worktree, rel);
    const info = await lstat(path).catch(undefinedIfMissing);
    // A link holds no data of its own (a mirror link into the main tree is the usual one), and a socket or fifo none at all.
    if (info === undefined || info.isSymbolicLink()) {
        return "judged";
    }
    if (info.isFile()) {
        if (!disposable(basename(rel)) && !(await sameAsMain(path, join(main, rel), info.size, budget))) {
            kept.push(rel);
        }
        return "judged";
    }
    if (!info.isDirectory()) {
        return "judged";
    }
    const names = (await readdir(path).catch(undefinedIfMissing)) ?? [];
    // Another repository's checkout or clone: its own retire (or the conversation's own `.git` handling) answers for it.
    if (names.includes(".git")) {
        return "judged";
    }
    const below: string[] = [];
    for (const name of names.toSorted()) {
        if (REGENERABLE_DIRS.has(name)) {
            continue;
        }
        if ((await judge(worktree, main, join(rel, name), budget, below)) === "cut") {
            return "cut";
        }
    }
    kept.push(...below);
    return "judged";
};

/** The checkout's ignored files that would be lost with it: neither regenerable nor identical to the main checkout's. */
export const scanAtRiskLocalFiles = async (
    worktree: string,
    main: string,
    git: GitRunner,
    limits: ScanLimits = DEFAULT_SCAN_LIMITS,
    now: () => number = Date.now,
): Promise<LocalFilesScan> => {
    // `--directory` reports a wholly ignored directory once, so a dependency tree is never listed file by file.
    const { stdout } = await git(worktree, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
    const entries = stdout
        .split("\0")
        .filter((entry) => entry !== "")
        .map((entry) => entry.replace(/\/$/u, ""))
        .filter((entry) => !entry.split("/").some((segment) => REGENERABLE_DIRS.has(segment)))
        .toSorted();
    const budget: Budget = { entries: 0, bytes: 0, until: now() + limits.deadlineMs, limits, now };
    const atRisk: string[] = [];
    let complete = true;
    for (const entry of entries) {
        const kept: string[] = [];
        if ((await judge(worktree, main, entry, budget, kept)) === "cut") {
            complete = false;
            // Not judged in time: kept whole. A file is cheap to keep; a directory goes as one rename.
            const info = await lstat(join(worktree, entry)).catch(undefinedIfMissing);
            if (info !== undefined && !info.isSymbolicLink()) {
                atRisk.push(info.isDirectory() ? `${entry}/` : entry);
            }
            continue;
        }
        atRisk.push(...kept);
    }
    return { atRisk, complete };
};

// What the trash entry says about itself, beside the files: where they came from, and whether the scan finished.
export const KEPT_MANIFEST = "kept-local-files.json";

/** Moves each at-risk path from the checkout into `dest`, keeping its checkout-relative place. Throws if one cannot move. */
const setAsideLocalFiles = async (
    worktree: string,
    scan: LocalFilesScan,
    dest: string,
    about: { readonly conversation: string; readonly repo: string; readonly at: number },
): Promise<void> => {
    await mkdir(dest, { recursive: true });
    for (const entry of scan.atRisk) {
        const rel = entry.replace(/\/$/u, "");
        const target = join(dest, "files", rel);
        await mkdir(dirname(target), { recursive: true });
        // The worktree and the trash both sit on the history volume, so this is a rename, never a copy.
        await rename(join(worktree, rel), target);
    }
    await writeFile(
        join(dest, KEPT_MANIFEST),
        `${JSON.stringify({ ...about, complete: scan.complete, paths: scan.atRisk }, null, 2)}\n`,
    );
};

export interface KeptPlace {
    readonly worktree: string;
    readonly main: string;
    readonly historyRoot: string;
    readonly id: string;
    readonly repo: string;
    readonly logger: Pick<Logger, "warn">;
}

/** Sets aside what only this checkout holds before it is removed (worktrees.ts releaseOne); throws if a move fails. */
export const keepLocalFiles = async (place: KeptPlace, git: GitRunner, limits?: ScanLimits): Promise<string | undefined> => {
    const { worktree, main, historyRoot, id, repo, logger } = place;
    // Never created or already retired, or its repository is gone (no git command can list anything): nothing to scan.
    if (!(await pathExists(join(worktree, ".git"))) || (await gitDirOf(worktree)) === undefined) {
        return undefined;
    }
    const scan = await scanAtRiskLocalFiles(worktree, main, git, limits);
    if (scan.atRisk.length === 0) {
        return undefined;
    }
    const at = Date.now();
    // Named like the trash's other checkout entries (`<repo>-<id>-…-<ms>`), the stamp last so the sweep reads its age.
    const dest = join(historyRoot, "trash", `${encodeURIComponent(repo)}-${id}-local-files-${at}`);
    await setAsideLocalFiles(worktree, scan, dest, { conversation: id, repo, at });
    logger.warn(
        { id, repo, kept: scan.atRisk.length, complete: scan.complete, dest },
        "agents: ignored files only this checkout held were moved to the trash before it was removed",
    );
    return dest;
};
