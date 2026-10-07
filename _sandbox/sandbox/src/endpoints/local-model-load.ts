import { errnoCode, undefinedIfMissing } from "@intentic/base/errors";
import { readdir, readFile } from "node:fs/promises";

// The one scan for this sandbox's own llama-server processes, which the idle sweep and the fit's "what a start frees"
// both read.

export interface LlamaServerProcess {
    readonly pid: number;
    // The `--port` it was told to bind, which is what ties a process to an entry (localModelPort).
    readonly port: number;
    // Resident memory: what stopping it gives back to the host.
    readonly residentBytes: number;
}

const PROC_PID = /^\d+$/u;

// What the scan reads of the machine's processes: /proc itself, or a test's stand-in for a process leaving mid-scan.
export interface ProcReads {
    readonly entries: () => Promise<readonly string[]>;
    readonly read: (path: string) => Promise<string>;
}

const liveProc: ProcReads = {
    entries: () => readdir("/proc").catch((): string[] => []),
    read: (path) => readFile(path, "utf8"),
};

// A process that exits mid-scan is no server of ours: its /proc entry answers ENOENT once it is gone, or ESRCH when it
// went between the open and the read. Either reads as nothing, so one process leaving never fails the whole scan
// (the idle sweep failed on about a quarter of its passes before this, 2026-10-05). Anything else still throws.
const goneIfVanished = (cause: unknown): undefined => {
    if (errnoCode(cause) === "ESRCH") {
        return undefined;
    }
    return undefinedIfMissing(cause);
};

const residentOf = async (pid: number, proc: ProcReads): Promise<number> =>
    proc.read(`/proc/${pid}/status`).then(
        (status) => Number(/^VmRSS:\s+(\d+) kB$/mu.exec(status)?.[1] ?? 0) * 1024,
        () => 0,
    );

// Found by argv, the panel manager knowing a tmux session and not a pid. `--port` and its VALUE as separate argv words,
// never a substring of the line: port 4048 would otherwise match the server on 40481.
export const llamaServerProcesses = async (proc: ProcReads = liveProc): Promise<LlamaServerProcess[]> => {
    const entries = await proc.entries();
    const found = await Promise.all(
        entries
            .filter((entry) => PROC_PID.test(entry))
            .map(async (entry): Promise<LlamaServerProcess | undefined> => {
                const argv = ((await proc.read(`/proc/${entry}/cmdline`).catch(goneIfVanished)) ?? "").split("\0");
                const flag = argv.indexOf("--port");
                const port = flag >= 0 ? Number(argv[flag + 1]) : Number.NaN;
                if (argv[0]?.includes("llama-server") !== true || !Number.isInteger(port)) {
                    return undefined;
                }
                const pid = Number(entry);
                return { pid, port, residentBytes: await residentOf(pid, proc) };
            }),
    );
    return found.filter((server) => server !== undefined);
};
