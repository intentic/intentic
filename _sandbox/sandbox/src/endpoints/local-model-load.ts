import { errnoCode, undefinedIfMissing } from "@intentic/base/errors";
import { open, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opt } from "../opt.js";

// What llama.cpp did with a model it loaded, read from the log the server writes as it loads: the pinned build (b11146)
// says where the layers went nowhere else, since neither /props nor /metrics carries the split. Also the one scan for
// this sandbox's own llama-server processes, which the idle sweep and the fit's "what a start frees" both read.

// One file per port, which llama-server truncates on every start (`--log-file` opens it for writing), so it only ever
// describes the load that is running. Under the OS temp dir rather than the workspace: it dies with the container, as
// the server it describes does.
export const localModelLogPath = (port: number): string => join(tmpdir(), `intentic-llama-${port}.log`);

export interface LoadReport {
    // llama.cpp's `load_tensors: offloaded N/M layers to GPU`. Absent when the build found no GPU to offload to: the
    // line is printed only by a build that can offload.
    readonly offloaded?: { readonly layers: number; readonly of: number };
    // What the load holds on a GPU (weights, KV cache and compute buffers on a CUDA device), in bytes.
    readonly gpuBytes: number;
}

// `--fit` measures with its own logging demoted below the default level, so the real load prints this once. The last
// one wins regardless, and only the buffers printed after it are counted.
const OFFLOADED = /offloaded (\d+)\/(\d+) layers to GPU/gu;
// `CUDA0`, never `CUDA_Host`: the host-pinned staging buffer is system RAM.
const DEVICE_BUFFER = /\bCUDA\d+ +(?:model|KV|RS|compute) buffer size = *([\d.]+) MiB/gu;

export const parseLoadLog = (log: string): LoadReport => {
    const last = [...log.matchAll(OFFLOADED)].at(-1);
    const after = last === undefined ? log : log.slice(last.index + last[0].length);
    const mib = [...after.matchAll(DEVICE_BUFFER)].reduce((sum, match) => sum + Number(match[1]), 0);
    return {
        ...opt("offloaded", last === undefined ? undefined : { layers: Number(last[1]), of: Number(last[2]) }),
        gpuBytes: Math.round(mib * 1024 * 1024),
    };
};

// The load is the first few dozen kilobytes; everything after it is one line per request, for as long as it serves.
const LOG_HEAD_BYTES = 1024 * 1024;

/** The running load on this port as its log tells it; undefined when there is no log to read. */
export const readLoadReport = async (port: number): Promise<LoadReport | undefined> => {
    const handle = await open(localModelLogPath(port), "r").catch(undefinedIfMissing);
    if (handle === undefined) {
        return undefined;
    }
    try {
        const buffer = Buffer.alloc(LOG_HEAD_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, LOG_HEAD_BYTES, 0);
        return parseLoadLog(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
        await handle.close();
    }
};

// What a model that should be on the GPU is doing instead, as a status line can say it; undefined when every layer is
// on the GPU, and when there is no report to go by: an unread log is not evidence of a CPU run.
export const offloadShortfall = (report: LoadReport | undefined): { readonly code: string; readonly detail: string } | undefined => {
    if (report === undefined) {
        return undefined;
    }
    const { offloaded } = report;
    if (offloaded === undefined) {
        return { code: "gpu-unused", detail: "running on the CPU: llama-server found no GPU to offload to" };
    }
    if (offloaded.layers === 0) {
        return { code: "gpu-unused", detail: `running on the CPU: none of its ${offloaded.of} layers fit on the GPU` };
    }
    if (offloaded.layers < offloaded.of) {
        return {
            code: "gpu-partial",
            detail: `only ${offloaded.layers} of ${offloaded.of} layers fit on the GPU, the rest run on the CPU and set its pace`,
        };
    }
    return undefined;
};

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
