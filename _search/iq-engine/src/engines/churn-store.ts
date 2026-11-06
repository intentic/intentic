import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@intentic/base/fs";

// One path's committed activity: the newest commit touching it, how many did, and the lines they added and removed.
export interface FileChurn {
    latestMs: number;
    commits: number;
    adds: number;
    dels: number;
}

// One repository's all-history churn, folded per repo-relative path as git prints it, as of the commit `head`. The
// sweep and floor filters are applied per read, not here, so one fold serves every scope.
export interface ChurnHistory {
    readonly head: string;
    readonly files: ReadonlyMap<string, FileChurn>;
}

// Bumped when the layout or what a fold counts changes; any other header reads as absent and is recomputed.
const HEADER = "iq-churn 1";

// A sibling of the index dir, like the vector cache: an index dropped on schema drift keeps it, since history is not
// derived from the index. Without it a fresh engine process (daemon restart, idle exit, memory recycle) diffs all of
// history again, measured at 31 s CPU and 109 s wall for this monorepo's 5.5k commits on a loaded host (2026-11-06).
export const churnStorePath = (indexDir: string): string => `${indexDir}-churn`;

const fileOf = (dir: string, key: string): string => join(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.txt`);

// Lines, not JSON: header, the key (the file name is only a hash prefix of it), head, one row per path, then a count
// that tells a whole file from a cut one. The path is last, so whatever characters git printed in it stay its own.
const HEAD = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ROW = /^(\d+)\t(\d+)\t(\d+)\t(\d+)\t(.+)$/;
const END = /^end (\d+)$/;

// Missing, unreadable, another version, another key's or cut short all read as nothing kept: the caller recomputes,
// never repairs.
export const loadChurn = async (dir: string, key: string): Promise<ChurnHistory | undefined> => {
    // allow(silent-catch): no file, or one that cannot be read, is nothing kept; the caller reads history afresh.
    const text = await readFile(fileOf(dir, key), "utf8").catch(() => undefined);
    const lines = text?.split("\n") ?? [];
    const head = lines[2] ?? "";
    const rows = lines.slice(3, -2);
    if (lines[0] !== HEADER || lines[1] !== JSON.stringify(key) || !HEAD.test(head) || Number(END.exec(lines.at(-2) ?? "")?.[1]) !== rows.length) {
        return undefined;
    }
    const files = new Map<string, FileChurn>();
    for (const row of rows) {
        const match = ROW.exec(row);
        if (match === null) {
            return undefined;
        }
        files.set(match[5]!, { latestMs: Number(match[1]), commits: Number(match[2]), adds: Number(match[3]), dels: Number(match[4]) });
    }
    return { head, files };
};

// Replaced whole, so a reader in another process (the CLI beside the daemon) sees one fold or the one before it.
export const saveChurn = async (dir: string, key: string, history: ChurnHistory): Promise<void> => {
    const rows = [...history.files].map(([file, churn]) => `${churn.latestMs}\t${churn.commits}\t${churn.adds}\t${churn.dels}\t${file}`);
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(fileOf(dir, key), [HEADER, JSON.stringify(key), history.head, ...rows, `end ${rows.length}`, ""].join("\n"));
};
