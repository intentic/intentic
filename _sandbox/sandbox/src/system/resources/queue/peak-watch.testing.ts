import type { PeakProc } from "./peak-watch.js";

// The /proc a peak watch reads (peak-watch.ts PeakProc), as a table a test edits between looks. Not part of the build.

export const PAGE_BYTES = 4096;

export interface FakeProcess {
    ppid: number;
    // Start, in clock ticks since boot: a pid read again with another start is another process.
    start: number;
    rssPages: number;
    // NUL-separated, as procfs gives it.
    cmdline: string;
    // Its pid in each namespace it is in, outermost first (/proc/<pid>/status NSpid); absent is none but this one.
    nspid?: readonly number[];
}

// One /proc/<pid>/stat line: parent, start (field 22) and resident pages (field 24) where the parser reads them.
const statLine = (pid: number, process: FakeProcess): string =>
    `${pid} (fake (one)) S ${process.ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${process.start} 1000000 ${process.rssPages}`;

const PROC_FILE = /^\/proc\/(\d+)\/(stat|cmdline|status)$/u;

export interface FakePeakProc {
    readonly proc: PeakProc;
    // What /proc holds, by pid: edit it between looks.
    readonly processes: Map<number, FakeProcess>;
}

export const fakePeakProc = (processes = new Map<number, FakeProcess>()): FakePeakProc => ({
    processes,
    proc: {
        listPids: async () => [...processes.keys()],
        readText: async (path) => {
            const [, pid, file] = PROC_FILE.exec(path) ?? [];
            const process = processes.get(Number(pid));
            if (process === undefined) {
                return undefined;
            }
            if (file === "stat") {
                return statLine(Number(pid), process);
            }
            return file === "cmdline" ? process.cmdline : `Name:\tfake\nNSpid:\t${(process.nspid ?? [Number(pid)]).join("\t")}\n`;
        },
        pageBytes: async () => PAGE_BYTES,
    },
});

/** queue-run's argv as procfs gives it, before its exec: bash, the wrapper, its flags, `--`, the command. */
export const queuedCmdline = (...command: readonly string[]): string =>
    `${["/usr/bin/bash", "/usr/local/bin/queue-run", "--pool", "cargo", "--label", "cargo-verify", "--", ...command].join("\0")}\0`;
