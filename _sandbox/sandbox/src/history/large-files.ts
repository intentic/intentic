import { mapPool } from "@intentic/base/async";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { HistoryGitRunner } from "./history.js";

// Files past this size stay out of history snapshots. A snapshot stores a full copy of every file it records, so a
// folder of films dropped into /work (30 GB of them, once) was hashed and written a second time onto the history
// volume. Nothing an agent edits is this size; a restore neither brings such a file back nor removes it.
export const MAX_SNAPSHOT_FILE_BYTES = 32 * 1024 * 1024;

// Files stat'ed at once while sizing up a snapshot's candidates.
const STAT_CONCURRENCY = 32;

// The scope's list of files left out: a gitignore of exact paths beside info/exclude. Read through
// `core.excludesFile` (largeFilesConfig) by the commands that consult ignores, so `add -A` skips these files and a
// restore's `clean` leaves them where they are. An exclude rather than a pathspec for exactly that second reason: a
// file merely left unstaged reads to `clean` as untracked, and a restore would delete it.
export const largeFilesList = (gitDir: string): string => join(gitDir, "info", "large-files");

export const largeFilesConfig = (gitDir: string): readonly string[] => ["-c", `core.excludesFile=${largeFilesList(gitDir)}`];

// A gitignore line matching exactly `path` (worktree-relative) and nothing else: anchored, every wildcard and escape
// character escaped, trailing spaces kept. A name with a line break cannot be written as a pattern, and is recorded.
export const literalPattern = (path: string): string | undefined => {
    if (/[\n\r]/u.test(path)) {
        return undefined;
    }
    const escaped = path.replaceAll(/[\\*?[\]!#]/gu, (char) => `\\${char}`).replace(/ +$/u, (spaces) => spaces.replaceAll(" ", "\\ "));
    return `/${escaped}`;
};

const unescapePattern = (line: string): string => line.slice(1).replaceAll(/\\(.)/gu, "$1");

const sizeOf = async (worktree: string, path: string): Promise<number> => {
    // allow(silent-catch): a path gone since it was listed is one there is nothing to leave out of.
    const entry = await lstat(join(worktree, path)).catch(() => undefined);
    return entry?.isFile() === true ? entry.size : 0;
};

const nulList = (stdout: string): string[] => stdout.split("\0").filter((path) => path !== "");

/**
 * Brings the scope's left-out list up to date before a snapshot's `add -A`: every file `add -A` is about to stage that
 * is past MAX_SNAPSHOT_FILE_BYTES goes on it, and every listed file that is gone or has shrunk back under comes off,
 * so the next snapshot records it. A recorded file that has grown past the limit is dropped from the snapshot index:
 * the copies already taken stay in older snapshots, and no new ones are made. A failure leaves the list as it was,
 * and the snapshot goes ahead without it.
 */
export const leaveOutLargeFiles = async (
    git: HistoryGitRunner,
    scope: { readonly name: string; readonly gitDir: string; readonly worktree: string },
    run: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
    logger: Logger,
): Promise<void> => {
    const listPath = largeFilesList(scope.gitDir);
    try {
        // allow(silent-catch): a scope that never had a large file has no list yet.
        const listed = new Set((await readFile(listPath, "utf8").catch(() => "")).split("\n").filter((line) => line.startsWith("/")).map(unescapePattern));
        // What `add -A` would stage: files nothing ignores (this list included), and recorded files changed since.
        const untracked = nulList((await git([...largeFilesConfig(scope.gitDir), "ls-files", "-z", "-o", "--exclude-standard"], run)).stdout);
        const changed = new Set(nulList((await git(["ls-files", "-z", "-m"], run)).stdout));
        const candidates = [...new Set([...listed, ...untracked, ...changed])];
        const large = new Map<string, number>();
        await mapPool(candidates, STAT_CONCURRENCY, async (path) => {
            const size = await sizeOf(scope.worktree, path);
            if (size > MAX_SNAPSHOT_FILE_BYTES && literalPattern(path) !== undefined) {
                large.set(path, size);
            }
        });
        const paths = [...large.keys()].sort();
        const unchanged = paths.length === listed.size && paths.every((path) => listed.has(path));
        if (!unchanged) {
            const lines = paths.map((path) => literalPattern(path) ?? "");
            await (paths.length === 0 ? rm(listPath, { force: true }) : writeFile(listPath, `${lines.join("\n")}\n`));
        }
        const untrack = paths.filter((path) => changed.has(path));
        if (untrack.length > 0) {
            // A file of pathspecs rather than arguments: the list is as long as the drop was. `-f` because the index entry
            // differs from the file by design, which `rm` otherwise refuses to drop.
            const pathspecs = join(scope.gitDir, "info", "large-files.untrack");
            await writeFile(pathspecs, untrack.map((path) => `:(literal)${path}\0`).join(""));
            try {
                await git(["rm", "--cached", "-f", "-q", "--ignore-unmatch", `--pathspec-from-file=${pathspecs}`, "--pathspec-file-nul"], run);
            } finally {
                await rm(pathspecs, { force: true });
            }
        }
        const added = paths.filter((path) => !listed.has(path));
        if (added.length > 0) {
            const bytes = added.reduce((sum, path) => sum + (large.get(path) ?? 0), 0);
            logger.info({ scope: scope.name, files: added.length, bytes }, "history: leaving large files out of snapshots");
        }
    } catch (error) {
        logger.warn({ err: error, scope: scope.name }, "history: could not size up large files; snapshotting without leaving them out");
    }
};
