import { open, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { pidsOf, procFile, sessionOf } from "../../../seams/session-processes.js";
import { jobRunnerPids } from "./job-processes.js";

/* OUTPUT A JOB SENT ELSEWHERE (2026-11-17, the shinobi-society audit). A job started as `cmd > /tmp/x.log 2>&1` prints
   nothing to its pane, so its capture stays empty and its mtime never moves: `wait` on it handed back an empty
   outputTail and "quiet for 7152 s" while the process was busily writing its log, and the agent fell back to polling the
   log with tail, grep and pgrep a dozen times. While the job runs, its processes' stdout and stderr are looked up in
   /proc: a regular file one of them writes to is where its output really goes, and its tail and its mtime stand in for
   the capture's, with the file named so the agent knows what it is reading. */

export interface RedirectedOutput {
    readonly path: string;
    readonly mtimeMs: number;
}

// Where one fd points, when that is a regular file outside the job's own dir (its capture is the job's own output, and a
// terminal, a pipe, a socket or /dev/null is not a file anybody can read on from).
const fileOf = async (procRoot: string, pid: number, fd: number, jobDir: string): Promise<RedirectedOutput | undefined> => {
    try {
        const target = await readlink(join(procRoot, String(pid), "fd", String(fd)));
        if (!target.startsWith("/") || target.startsWith("/dev/") || target.startsWith("/proc/") || target.startsWith(`${jobDir}/`) || target.endsWith(" (deleted)")) {
            return undefined;
        }
        const info = await stat(target);
        return info.isFile() ? { path: target, mtimeMs: info.mtimeMs } : undefined;
    } catch {
        // allow(silent-catch): a process gone, an fd closed or a file unreadable mid-look says nothing about where output goes.
        return undefined;
    }
};

/**
 * The file the job's processes write their output to, when it is not the pane: the most recently written of their
 * stdout and stderr targets that are regular files. Undefined when the job's runner is gone or nothing of it writes to
 * a file. Never throws.
 */
export const redirectedOutput = async (jobDir: string, procRoot = "/proc"): Promise<RedirectedOutput | undefined> => {
    try {
        const leader = (await jobRunnerPids([jobDir], procRoot)).get(jobDir);
        if (leader === undefined) {
            return undefined;
        }
        let newest: RedirectedOutput | undefined;
        for (const pid of await pidsOf(procRoot)) {
            if (pid !== leader && sessionOf(await procFile(join(procRoot, String(pid), "stat"))) !== leader) {
                continue;
            }
            for (const fd of [1, 2]) {
                const file = await fileOf(procRoot, pid, fd, jobDir);
                if (file !== undefined && (newest === undefined || file.mtimeMs > newest.mtimeMs)) {
                    newest = file;
                }
            }
        }
        return newest;
    } catch {
        // allow(silent-catch): /proc unreadable for one look leaves the report on the capture, as before.
        return undefined;
    }
};

/** The last `bytes` of a file, decoded; empty when it cannot be read. */
export const fileTail = async (path: string, bytes: number): Promise<string> => {
    try {
        const handle = await open(path, "r");
        try {
            const { size } = await handle.stat();
            const length = Math.min(size, bytes);
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, size - length);
            return buffer.toString("utf8");
        } finally {
            await handle.close();
        }
    } catch {
        // allow(silent-catch): a log removed or unreadable since the look has no tail to show, which reads as empty.
        return "";
    }
};
