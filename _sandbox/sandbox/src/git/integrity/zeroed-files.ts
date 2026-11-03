import { open, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { GitRunner } from "@intentic/base/git";

// FILES A HOST CRASH ZEROED (2026-11-03). When rog lost power under WSL2, 22 files of one checkout came back at their
// right size and every byte NUL: the filesystem had kept their length and lost their data. The next turn's checkpoint
// committed them as edits ("authority.rs | Bin 11664 -> 11664 bytes"), and the good content survived only in the commit
// before. A tracked text file does not become all NUL at the same size by anyone's hand, nor a non-empty one empty on
// its own between two turns, so the checkpoint leaves such a file out of its commit (HEAD keeps the last good
// content) and says so, rather than burying the damage under a commit nobody reads.

// What is read to decide; past it a file is neither confirmed nor passed, and taken as written.
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const CHUNK = 64 * 1024;
// Git's own binary test: a NUL within the first 8000 bytes.
const TEXT_PROBE = 8000;
// A checkout with thousands of modified files is a bulk edit, not a crash; the scan stops caring past this many.
const MAX_CANDIDATES = 2000;

export interface ZeroedFile {
    readonly path: string;
    readonly size: number;
    // `nul`: every byte NUL at HEAD's size; `emptied`: empty where HEAD has content.
    readonly how: "nul" | "emptied";
}

// Whether every byte of the file is NUL; undefined when it could not be read whole within the budget.
const allNul = async (file: string, size: number): Promise<boolean | undefined> => {
    if (size > MAX_SCAN_BYTES) {
        return undefined;
    }
    const handle = await open(file, "r");
    try {
        const buffer = Buffer.alloc(CHUNK);
        for (let offset = 0; offset < size; ) {
            const { bytesRead } = await handle.read(buffer, 0, CHUNK, offset);
            if (bytesRead === 0) {
                return undefined;
            }
            if (buffer.subarray(0, bytesRead).some((byte) => byte !== 0)) {
                return false;
            }
            offset += bytesRead;
        }
        return true;
    } finally {
        await handle.close();
    }
};

// The tracked files whose working copy differs from HEAD, by path.
const modifiedPaths = async (dir: string, git: GitRunner): Promise<string[]> => {
    const { stdout } = await git(dir, ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=M", "HEAD", "--"]);
    return stdout.split("\0").filter((path) => path !== "");
};

// HEAD's blob size per path, for regular files only.
const headSizes = async (dir: string, paths: readonly string[], git: GitRunner): Promise<Map<string, number>> => {
    const { stdout } = await git(dir, ["ls-tree", "-l", "-z", "HEAD", "--", ...paths]);
    const sizes = new Map<string, number>();
    for (const record of stdout.split("\0")) {
        // `<mode> blob <sha> <size>\t<path>`
        const match = /^100\d{3} blob [0-9a-f]+ +(\d+)\t(.+)$/s.exec(record);
        if (match?.[1] !== undefined && match[2] !== undefined) {
            sizes.set(match[2], Number(match[1]));
        }
    }
    return sizes;
};

// Whether HEAD's copy of the file reads as text to git (no NUL in its first 8000 bytes).
const headIsText = async (dir: string, path: string, git: GitRunner): Promise<boolean> => {
    // allow(silent-catch): a blob that cannot be read is not one this vouches for, and the file is taken as written.
    const blob = await git(dir, ["cat-file", "blob", `HEAD:${path}`]).catch(() => undefined);
    return blob !== undefined && !blob.stdout.slice(0, TEXT_PROBE).includes("\0");
};

const judge = async (dir: string, path: string, headSize: number, git: GitRunner): Promise<ZeroedFile | undefined> => {
    // allow(silent-catch): a path gone between the diff and this read is a delete, not damage.
    const stats = await lstat(join(dir, path)).catch(() => undefined);
    if (stats?.isFile() !== true || headSize === 0) {
        return undefined;
    }
    const how = stats.size === 0 ? "emptied" : stats.size === headSize && (await allNul(join(dir, path), stats.size)) === true ? "nul" : undefined;
    if (how === undefined || !(await headIsText(dir, path, git))) {
        return undefined;
    }
    return { path, size: stats.size, how };
};

/** The tracked text files in a checkout that a crash zeroed: all NUL at HEAD's size, or emptied of HEAD's content. */
export const zeroedFiles = async (dir: string, git: GitRunner): Promise<ZeroedFile[]> => {
    const paths = await modifiedPaths(dir, git);
    if (paths.length === 0 || paths.length > MAX_CANDIDATES) {
        return [];
    }
    const sizes = await headSizes(dir, paths, git);
    const found: ZeroedFile[] = [];
    for (const path of paths) {
        const headSize = sizes.get(path);
        // one stat (and, for a NUL-looking file, one read) per modified file; a checkout modifies a handful
        const zeroed = headSize === undefined ? undefined : await judge(dir, path, headSize, git);
        if (zeroed !== undefined) {
            found.push(zeroed);
        }
    }
    return found;
};
