import { stat } from "node:fs/promises";
import { join } from "node:path";
import { stderrOf, stdoutOf } from "@intentic/base/errors";
import type { GitRunner } from "@intentic/base/git";
import { opt } from "../../opt.js";
import { commonDirOf, gitDirOf } from "../../store/git/git-dir.js";
import { quarantine, scanLooseObjects } from "./loose-objects.js";
import { badRefs, restoreRef } from "./ref-files.js";

// ONE REPOSITORY'S REPAIR AFTER A CRASH (2026-11-03). The 10-30 crash left 45 zeroed loose objects in /history/gits/root
// and nothing noticed until a land died on one 15 hours later; repairing it by hand rebuilt 38 of them from checkout
// files whose content still hashed to the lost blob. This does that pass itself, in order: read every loose object and
// set the damaged ones aside (git then reads them as absent, and finds a packed copy if one exists); put zeroed refs
// back from their reflogs; ask git which objects are now missing (`fsck --connectivity-only`, which also reads every
// worktree's index); re-create each missing blob from any worktree file that still hashes to it, and each missing tree
// from a worktree index that still describes it (`write-tree`); then ask git once more. What is left is lost, and said.

// fsck stops at the first corrupt object it trips on (one the byte scan passed: a large one only header-checked), so
// each such stop sets that one aside and asks again, this many times at most.
const FSCK_ROUNDS = 20;
// allow(dependency-text): git's own fsck wording; untranslated, as every git the runner starts.
const MISSING = /^missing (blob|tree|commit|tag) ([0-9a-f]{40}(?:[0-9a-f]{24})?)$/gm;
// allow(dependency-text): git's fatal line for a loose object it cannot inflate, naming the file.
const CORRUPT_LOOSE = /loose object ([0-9a-f]{40}(?:[0-9a-f]{24})?) \(stored in [^)]*\) is corrupt/;

export interface RepoRepair {
    readonly repo: string;
    // The repository's shared git dir, where its quarantine is; absent when none was found.
    readonly commonDir?: string;
    readonly scanned: number;
    // Loose objects set aside as unreadable.
    readonly quarantined: readonly string[];
    // Objects that were missing and were written again from a checkout.
    readonly rebuilt: readonly string[];
    // Objects still missing: whatever names them (a commit, a tree, an index entry) cannot be read.
    readonly missing: readonly { readonly sha: string; readonly type: string }[];
    readonly refsRestored: readonly string[];
    readonly refsLost: readonly string[];
    // Why the check did not finish (its budget ran out, or git could not be asked); what it found so far still stands.
    readonly incomplete?: string;
}

export interface RepairOptions {
    readonly git: GitRunner;
    readonly deadline: number;
    readonly now?: () => number;
}

interface Fsck {
    readonly missing: { readonly sha: string; readonly type: string }[];
    readonly corrupt?: string;
    readonly failed?: string;
}

const fsck = async (dir: string, git: GitRunner): Promise<Fsck> => {
    try {
        await git(dir, ["fsck", "--connectivity-only", "--no-dangling", "--no-progress"]);
        return { missing: [] };
    } catch (error) {
        const said = `${stdoutOf(error) ?? ""}\n${stderrOf(error) ?? ""}`;
        const missing = [...said.matchAll(MISSING)].map((match) => ({ type: match[1] ?? "", sha: match[2] ?? "" }));
        const corrupt = CORRUPT_LOOSE.exec(said)?.[1];
        if (corrupt !== undefined) {
            return { missing, corrupt };
        }
        return missing.length > 0 ? { missing } : { missing, failed: said.trim().split("\n").at(-1) ?? "git fsck failed" };
    }
};

// Every checkout of the repository that is on disk: the main one and each linked worktree.
const checkoutsOf = async (dir: string, git: GitRunner): Promise<string[]> => {
    const { stdout } = await git(dir, ["worktree", "list", "--porcelain", "-z"]);
    const paths = stdout
        .split("\0")
        .filter((field) => field.startsWith("worktree "))
        .map((field) => field.slice("worktree ".length));
    const present: string[] = [];
    for (const path of paths) {
        // allow(silent-catch): a worktree whose directory is gone has no files to rebuild from.
        if ((await stat(path).catch(() => undefined))?.isDirectory() === true) {
            present.push(path);
        }
    }
    return present;
};

// Index entries per wanted blob: `<mode> <sha> <stage>\t<path>`.
const indexPathsFor = async (checkout: string, wanted: ReadonlySet<string>, git: GitRunner): Promise<Map<string, string[]>> => {
    // allow(silent-catch): an index git cannot read names nothing to rebuild from; fsck already counted what it loses.
    const listed = await git(checkout, ["ls-files", "-s", "-z"]).catch(() => ({ stdout: "" }));
    const paths = new Map<string, string[]>();
    for (const record of listed.stdout.split("\0")) {
        const match = /^\d{6} ([0-9a-f]+) \d\t(.+)$/s.exec(record);
        if (match?.[1] !== undefined && match[2] !== undefined && wanted.has(match[1])) {
            paths.set(match[1], [...(paths.get(match[1]) ?? []), match[2]]);
        }
    }
    return paths;
};

// Writes a missing blob back from a checkout file whose content still hashes to it, filters applied as `add` applies
// them. Hashed first without writing, so a file that changed since writes nothing.
const rebuildBlob = async (checkout: string, sha: string, paths: readonly string[], git: GitRunner): Promise<boolean> => {
    for (const path of paths) {
        // a missing blob has one or two candidate files; each costs one hash
        // allow(silent-catch): a file that cannot be hashed (gone, unreadable) is simply not the copy.
        const hashed = await git(checkout, ["hash-object", "--", path]).catch(() => undefined);
        if (hashed?.stdout.trim() === sha) {
            await git(checkout, ["hash-object", "-w", "--", path]);
            return true;
        }
    }
    return false;
};

const rebuildBlobs = async (dir: string, blobs: readonly string[], git: GitRunner): Promise<string[]> => {
    const wanted = new Set(blobs);
    const rebuilt: string[] = [];
    for (const checkout of await checkoutsOf(dir, git)) {
        if (wanted.size === 0) {
            break;
        }
        // one index read per checkout; a repository has tens of worktrees at most
        const candidates = await indexPathsFor(checkout, wanted, git);
        for (const [sha, paths] of candidates) {
            if (wanted.has(sha) && (await rebuildBlob(checkout, sha, paths, git))) {
                wanted.delete(sha);
                rebuilt.push(sha);
            }
        }
    }
    return rebuilt;
};

// Each checkout's index describes its trees; writing them back costs nothing when they exist and restores one a crash
// zeroed when the index still matches it. Objects nothing names are left for gc.
const rewriteTrees = async (dir: string, git: GitRunner): Promise<void> => {
    for (const checkout of await checkoutsOf(dir, git)) {
        // allow(silent-catch): an index that cannot be written as trees (its own blobs missing) leaves its trees as they were.
        await git(checkout, ["write-tree", "--missing-ok"]).catch(() => undefined);
    }
};

// Sets aside whatever fsck trips on, round by round, and returns the last answer.
const settledFsck = async (dir: string, commonDir: string, stamp: string, quarantined: string[], git: GitRunner): Promise<Fsck> => {
    for (let round = 0; ; round += 1) {
        // a round per corrupt object the byte scan let through; normally zero
        const answer = await fsck(dir, git);
        if (answer.corrupt === undefined || round >= FSCK_ROUNDS) {
            return answer;
        }
        await quarantine(commonDir, stamp, join("objects", answer.corrupt.slice(0, 2), answer.corrupt.slice(2)));
        quarantined.push(answer.corrupt);
    }
};

const restoreRefs = async (commonDir: string, stamp: string, git: GitRunner, dir: string): Promise<{ restored: string[]; lost: string[] }> => {
    const restored: string[] = [];
    const lost: string[] = [];
    for (const ref of await badRefs(commonDir)) {
        // allow(silent-catch): a commit git cannot find is not one the ref can go back to.
        const there = ref.lastLogged === undefined ? false : await git(dir, ["cat-file", "-e", `${ref.lastLogged}^{commit}`]).then(() => true, () => false);
        if (there && ref.lastLogged !== undefined) {
            await restoreRef(commonDir, ref.path, ref.lastLogged);
            restored.push(ref.path);
        } else {
            // A HEAD stays where it is (git needs the file); any other ref goes, so the rest of the repository reads.
            if (!ref.path.endsWith("HEAD")) {
                await quarantine(commonDir, stamp, ref.path);
            }
            lost.push(ref.path);
        }
    }
    return { restored, lost };
};

/** Checks one repository's objects and refs, repairing what it can; `dir` is any checkout of it. */
export const repairRepo = async (repo: string, dir: string, options: RepairOptions): Promise<RepoRepair> => {
    const { git, deadline } = options;
    const now = options.now ?? Date.now;
    const gitDir = await gitDirOf(dir);
    const empty = { repo, scanned: 0, quarantined: [], rebuilt: [], missing: [], refsRestored: [], refsLost: [] };
    if (gitDir === undefined) {
        return { ...empty, incomplete: "no git dir" };
    }
    const commonDir = await commonDirOf(gitDir);
    const stamp = new Date(now()).toISOString().replaceAll(":", "-");
    const scan = await scanLooseObjects(commonDir, deadline, now);
    const quarantined = scan.bad.map(({ sha }) => sha);
    for (const object of scan.bad) {
        await quarantine(commonDir, stamp, object.path);
    }
    const refs = await restoreRefs(commonDir, stamp, git, dir);
    const first = await settledFsck(dir, commonDir, stamp, quarantined, git);
    let rebuilt: string[] = [];
    let final = first;
    if (first.missing.length > 0) {
        rebuilt = await rebuildBlobs(
            dir,
            first.missing.filter(({ type }) => type === "blob").map(({ sha }) => sha),
            git,
        );
        if (first.missing.some(({ type }) => type === "tree")) {
            await rewriteTrees(dir, git);
        }
        final = await settledFsck(dir, commonDir, stamp, quarantined, git);
        const before = new Set(final.missing.map(({ sha }) => sha));
        // A tree `write-tree` brought back counts as rebuilt too.
        rebuilt = [...rebuilt, ...first.missing.filter(({ sha, type }) => type === "tree" && !before.has(sha)).map(({ sha }) => sha)];
    }
    const incomplete = scan.cut ? "the loose-object scan ran out of time" : (final.failed ?? (final.corrupt === undefined ? undefined : "fsck kept finding corrupt objects"));
    return {
        repo,
        commonDir,
        scanned: scan.scanned,
        quarantined,
        rebuilt,
        missing: final.missing,
        refsRestored: refs.restored,
        refsLost: refs.lost,
        ...opt("incomplete", incomplete),
    };
};
