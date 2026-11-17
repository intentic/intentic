import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

/* HOW MUCH MEMORY ONE OFFLOADED LINE HELD (RunnerCommand frames' `peakMemoryMb`). The line runs in a session of its own
   (runner-command.ts), so everything it started, however deep (rustc under cargo, a linker under rustc), shares that
   session id: the resident memory of every process in it, summed and sampled, is what the line held. The peak is what
   the parent plans the next run of the same line by (offload/command-profiles.ts), so a workspace-wide build that took
   14 GiB is never again sent to a machine with 8 free. Linux only; elsewhere nothing is measured. */

const SAMPLE_MS = 1_000;

// The kernel's page size, read once from what this very process reports both ways; the common sizes only.
let pageBytes: number | undefined;
const pageSize = (): number => {
    if (pageBytes !== undefined) {
        return pageBytes;
    }
    try {
        const pages = Number(readFileSync("/proc/self/statm", "utf8").split(" ")[1]);
        const ratio = process.memoryUsage.rss() / pages;
        pageBytes = [4096, 16_384, 65_536].reduce((best, size) => (Math.abs(size - ratio) < Math.abs(best - ratio) ? size : best));
    } catch {
        // allow(silent-catch): no procfs means nothing is measured anyway; the usual page size keeps the arithmetic sane
        pageBytes = 4096;
    }
    return pageBytes;
};

// /proc/<pid>/stat after the command name, which may itself hold spaces and parentheses: session is the 4th field
// there, resident pages the 22nd.
const SESSION_FIELD = 3;
const RSS_FIELD = 21;

/** The resident bytes of every process in session `sid`; undefined where /proc cannot be read. */
const sessionRssBytes = async (sid: number): Promise<number | undefined> => {
    let pids: string[];
    try {
        pids = (await readdir("/proc")).filter((name) => /^\d+$/u.test(name));
    } catch {
        // allow(silent-catch): no procfs, no measurement
        return undefined;
    }
    let pages = 0;
    for (const pid of pids) {
        // allow(silent-catch): a process that ended between the listing and the read held nothing
        const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
        if (stat === undefined) {
            continue;
        }
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[SESSION_FIELD]) === sid) {
            pages += Number(fields[RSS_FIELD]) || 0;
        }
    }
    return pages * pageSize();
};

export interface SessionPeak {
    // Stops sampling and answers the peak in MiB, or undefined if nothing was read.
    readonly stop: () => number | undefined;
}

/** Samples a session's memory until stopped. */
export const watchSessionPeak = (sid: number): SessionPeak => {
    let peak: number | undefined;
    let reading = false;
    const sample = (): void => {
        if (reading) {
            return;
        }
        reading = true;
        void sessionRssBytes(sid)
            .then((bytes) => {
                if (bytes !== undefined && bytes > 0) {
                    peak = Math.max(peak ?? 0, bytes);
                }
            })
            .finally(() => {
                reading = false;
            });
    };
    sample();
    const timer = setInterval(sample, SAMPLE_MS);
    timer.unref();
    return {
        stop: () => {
            clearInterval(timer);
            return peak === undefined ? undefined : Math.round(peak / 1_048_576);
        },
    };
};
