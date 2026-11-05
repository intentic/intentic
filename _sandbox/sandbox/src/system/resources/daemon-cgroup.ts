import { readFile, writeFile } from "node:fs/promises";
import type { Logger } from "pino";
import { errorMessage } from "@intentic/base/errors";
import { defaultSwapGib, SWAP_ENV, WORKLOAD_BOUNDS_OVERRIDE, WorkloadBoundsOverrideSchema, workloadMemoryMax } from "./memory-records.js";

// THE DAEMON'S OWN CGROUP, KEPT AS THE ENTRYPOINT MEANT IT. docker-entrypoint.sh puts the daemon in a `daemon` leaf with
// no swap and the top cpu and io weight, so that a box short of memory swaps out a build rather than the heap every
// request waits on. On 2026-10-13 a sandbox had run all day with that leaf at the kernel's defaults (swap max, weight
// 100): the entrypoint's writes are silent on refusal, and the leaf had no controller files when it wrote, its root
// enabling them (all six, where the entrypoint asks for three) only later. 559 MiB of the daemon's heap sat in swap,
// 3.6 M pages had come back in, and its event loop froze for up to 20 s, once for long enough to fail a turn's setup.
// So the daemon checks its own leaf at boot and every minute after, writes what differs, and says so.

const CGROUP_ROOT = "/sys/fs/cgroup";

// What the entrypoint writes into the daemon's leaf, by file, as each file reads back.
export const DAEMON_LEAF_SETTINGS: readonly { readonly file: string; readonly value: string }[] = [
    { file: "memory.swap.max", value: "0" },
    { file: "cpu.weight", value: "1000" },
    // Absent on a kernel without an io weight scheduler (no iocost or BFQ): then there is nothing to keep.
    { file: "io.weight", value: "default 1000" },
];

// The one setting worth a word when its file is missing: without it nothing keeps the heap out of swap.
const PROTECTION = "memory.swap.max";

export interface CgroupFiles {
    readonly read: (path: string) => Promise<string | undefined>;
    readonly write: (path: string, value: string) => Promise<void>;
}

const files: CgroupFiles = {
    // allow(silent-catch): a file this kernel or cgroup lacks is the absent value every caller handles.
    read: (path) => readFile(path, "utf8").catch(() => undefined),
    write: (path, value) => writeFile(path, value),
};

// A process's cgroup2 path, from its `/proc/<pid>/cgroup`: the `0::` line, or undefined on a host without cgroup2.
const cgroupPathOf = (procCgroup: string): string | undefined => procCgroup.split("\n").find((line) => line.startsWith("0::"))?.slice(3).trim();

/** The daemon's leaf, when the entrypoint put it in one: `/proc/self/cgroup`'s path ending in `/daemon` (netd's rule). */
export const daemonLeafOf = (procSelfCgroup: string): string | undefined => {
    const path = cgroupPathOf(procSelfCgroup);
    return path !== undefined && path.endsWith("/daemon") ? `${CGROUP_ROOT}${path}` : undefined;
};

/** The entrypoint's `workload` leaf beside the daemon's, for a process in either of the two; undefined anywhere else. */
export const workloadLeafOf = (procSelfCgroup: string): string | undefined => {
    const path = cgroupPathOf(procSelfCgroup);
    if (path === undefined || !(path.endsWith("/daemon") || path.endsWith("/workload"))) {
        return undefined;
    }
    return `${CGROUP_ROOT}${path.slice(0, path.lastIndexOf("/"))}/workload`;
};

// A cgroup file's value as written: its first line, trimmed (io.weight lists per-device overrides after the default).
const valueOf = (text: string): string => (text.split("\n")[0] ?? "").trim();

export interface LeafCheck {
    readonly restored: readonly { readonly file: string; readonly was: string }[];
    readonly refused: readonly { readonly file: string; readonly reason: string }[];
    readonly missing: readonly string[];
}

/** One pass over the daemon's leaf: each setting read, and written where it differs. */
export const checkDaemonLeaf = async (leaf: string, io: CgroupFiles = files): Promise<LeafCheck> => {
    const restored: { file: string; was: string }[] = [];
    const refused: { file: string; reason: string }[] = [];
    const missing: string[] = [];
    for (const { file, value } of DAEMON_LEAF_SETTINGS) {
        const path = `${leaf}/${file}`;
        const text = await io.read(path);
        if (text === undefined) {
            missing.push(file);
            continue;
        }
        const was = valueOf(text);
        if (was === value) {
            continue;
        }
        try {
            await io.write(path, value);
            restored.push({ file, was });
        } catch (error) {
            refused.push({ file, reason: errorMessage(error) });
        }
    }
    return { restored, refused, missing };
};

/* THE WORKLOAD LEAF'S BOUNDS (2026-11-05). Everything an agent starts runs in the `workload` leaf beside the daemon's, and
   it ran there with no bound of its own: a game client grew to 17.6 GB resident and 33 GB of swap, because the engine
   silently drops `--memory-swap`, and the WSL VM paged for 1 h 48 m until netd killed the frozen daemon and five turns came
   back interrupted. The entrypoint bounds the leaf as the container starts; the daemon keeps the same bounds every minute
   after, by the same precedence and memory-records.ts's formulas, which is also how a live reshape reaches it: ic writes
   the new swap into WORKLOAD_BOUNDS_OVERRIDE (or changes the container's cap) and the next pass writes what differs. */

const GIB = 1024 ** 3;

// What the bounds are worked out from, read fresh on every pass: the sandbox's cap (the root's memory.max, undefined for
// `max`), the machine's own memory standing in for a cap the sandbox has none of, ic's env var and its override file.
export interface WorkloadBoundsInputs {
    readonly capBytes: number | undefined;
    readonly machineBytes: number | undefined;
    readonly swapEnv: string | undefined;
    readonly override: string | undefined;
}

// Whole GiB from ic's `<n>g`, at least 1: a leaf with no swap livelocks reclaiming file pages instead of reaching its OOM.
const swapEnvGib = (value: string | undefined): number | undefined => {
    const gib = Number(/^(\d+)g$/u.exec(value?.trim() ?? "")?.[1] ?? Number.NaN);
    return Number.isSafeInteger(gib) && gib >= 1 ? gib : undefined;
};

const overrideGib = (text: string | undefined): number | undefined => {
    if (text === undefined) {
        return undefined;
    }
    try {
        return WorkloadBoundsOverrideSchema.safeParse(JSON.parse(text)).data?.swapGib;
    } catch {
        // allow(silent-catch): a file ic was still writing, or one nobody should have written, is no bound; the env and the default stand.
        return undefined;
    }
};

/** The workload leaf's swap bound in whole GiB: the override file, else ic's env var, else a share of the cap. */
const workloadSwapGib = (inputs: WorkloadBoundsInputs): number =>
    overrideGib(inputs.override) ?? swapEnvGib(inputs.swapEnv) ?? defaultSwapGib(inputs.capBytes ?? inputs.machineBytes ?? GIB);

/** The three bounds by file, as each reads back: a wall below the cap (none without one), the swap, no group kill. */
export const workloadBounds = (inputs: WorkloadBoundsInputs): readonly { readonly file: string; readonly value: string }[] => [
    { file: "memory.max", value: inputs.capBytes === undefined ? "max" : String(workloadMemoryMax(inputs.capBytes)) },
    { file: "memory.swap.max", value: String(workloadSwapGib(inputs) * GIB) },
    // 0: the kernel kills the process it scores worst, never every process in the leaf with it, which would take the
    // owner's dev server and every other conversation's build down with one runaway.
    { file: "memory.oom.group", value: "0" },
];

const capOf = (text: string | undefined): number | undefined => {
    const bytes = Number((text ?? "").trim());
    return /^\d+$/u.test((text ?? "").trim()) && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
};

const machineBytesOf = (meminfo: string | undefined): number | undefined => {
    const kib = Number(/^MemTotal:\s+(\d+) kB$/mu.exec(meminfo ?? "")?.[1] ?? Number.NaN);
    return Number.isFinite(kib) && kib > 0 ? kib * 1024 : undefined;
};

export interface WorkloadCheck extends LeafCheck {
    readonly restored: readonly { readonly file: string; readonly was: string; readonly now: string }[];
}

/** One pass over the workload leaf: each bound read, and written where it differs. `root` holds both leaves. */
export const checkWorkloadLeaf = async (root: string, swapEnv: string | undefined, io: CgroupFiles = files): Promise<WorkloadCheck> => {
    const [cap, meminfo, override] = await Promise.all([io.read(`${root}/memory.max`), io.read("/proc/meminfo"), io.read(WORKLOAD_BOUNDS_OVERRIDE)]);
    const leaf = `${root}/workload`;
    const restored: { file: string; was: string; now: string }[] = [];
    const refused: { file: string; reason: string }[] = [];
    const missing: string[] = [];
    for (const { file, value } of workloadBounds({ capBytes: capOf(cap), machineBytes: machineBytesOf(meminfo), swapEnv, override })) {
        const path = `${leaf}/${file}`;
        const text = await io.read(path);
        if (text === undefined) {
            missing.push(file);
            continue;
        }
        const was = valueOf(text);
        if (was === value) {
            continue;
        }
        try {
            await io.write(path, value);
            restored.push({ file, was, now: value });
        } catch (error) {
            refused.push({ file, reason: errorMessage(error) });
        }
    }
    return { restored, refused, missing };
};

/* THE DAEMON IN ITS OWN LEAF. The entrypoint puts the shell it execs netd from into the daemon leaf, and netd's child, this
   daemon, is born there. Observed live on 2026-11-05: the daemon (pid 64) in `workload` instead, under the bounds above and
   beside the runaway, swapping with it. Only the daemon netd supervises belongs in the daemon leaf, and netd is in it, so
   the test is the parent: a daemon whose parent sits in the daemon leaf while it sits in `workload` moves itself back. A
   second daemon an agent started from its shell has a parent in `workload` and stays there, as netd would keep it. */

type Placement =
    | { readonly kind: "leaf"; readonly leaf: string }
    | { readonly kind: "moved"; readonly leaf: string; readonly from: string }
    | { readonly kind: "refused"; readonly leaf: string; readonly from: string; readonly reason: string }
    | { readonly kind: "none" };

const placeDaemon = async (io: CgroupFiles, pid: number, ppid: number): Promise<Placement> => {
    const own = (await io.read("/proc/self/cgroup")) ?? "";
    const leaf = daemonLeafOf(own);
    if (leaf !== undefined) {
        return { kind: "leaf", leaf };
    }
    const path = cgroupPathOf(own);
    if (path === undefined || !path.endsWith("/workload")) {
        return { kind: "none" };
    }
    const parent = daemonLeafOf((await io.read(`/proc/${String(ppid)}/cgroup`)) ?? "");
    const sibling = `${CGROUP_ROOT}${path.slice(0, path.lastIndexOf("/"))}/daemon`;
    if (parent !== sibling) {
        return { kind: "none" };
    }
    try {
        await io.write(`${sibling}/cgroup.procs`, String(pid));
        return { kind: "moved", leaf: sibling, from: `${CGROUP_ROOT}${path}` };
    } catch (error) {
        return { kind: "refused", leaf: sibling, from: `${CGROUP_ROOT}${path}`, reason: errorMessage(error) };
    }
};

export interface DaemonCgroupKeeper {
    readonly stop: () => void;
}

// The cgroup2 mount's options (`ro,nosuid,…`) as /proc/mounts lists them, or undefined where none is at the root.
export const cgroupMountOptions = (mounts: string): string | undefined =>
    mounts
        .split("\n")
        .map((line) => line.split(" "))
        .find((fields) => fields[1] === CGROUP_ROOT && fields[2] === "cgroup2")?.[3];

/** Keeps the daemon's leaf as the entrypoint meant it, the daemon itself in it, and the workload leaf beside it bounded:
 * at boot and every `intervalMs`, said once per file each way (once per bound a reshape sets).
 * `container` is whether this daemon runs as a sandbox's container: there a container with no daemon leaf at all is said
 * once, since nothing then keeps the heap out of swap (a compose sandbox's read-only cgroup filesystem, 2026-10-27);
 * a local daemon, and a guest beside a leaf another daemon holds, have none to keep and say nothing. `pid`, `ppid` and
 * `swapEnv` are this process's own unless a test names others. */
export const startDaemonCgroupKeeper = (
    logger: Pick<Logger, "warn" | "info">,
    options: {
        readonly intervalMs?: number;
        readonly io?: CgroupFiles;
        readonly container?: boolean;
        readonly pid?: number;
        readonly ppid?: number;
        readonly swapEnv?: string | undefined;
    } = {},
): DaemonCgroupKeeper => {
    const io = options.io ?? files;
    const swapEnv = "swapEnv" in options ? options.swapEnv : process.env[SWAP_ENV];
    // Said once a daemon life per file and outcome: a leaf something keeps resetting would otherwise say it every minute.
    const said = new Set<string>();
    const once = (key: string, say: () => void): void => {
        if (!said.has(key)) {
            said.add(key);
            say();
        }
    };
    const pass = async (): Promise<void> => {
        const placement = await placeDaemon(io, options.pid ?? process.pid, options.ppid ?? process.ppid);
        if (placement.kind === "moved") {
            once(`moved:${placement.from}`, () => {
                logger.warn({ leaf: placement.leaf, from: placement.from }, "daemon cgroup: the daemon was running in the workload leaf, under the bounds every agent process is held to, moved it back into its own");
            });
        } else if (placement.kind === "refused") {
            once(`move-refused:${placement.from}`, () => {
                logger.warn({ leaf: placement.leaf, from: placement.from, reason: placement.reason }, "daemon cgroup: the daemon is running in the workload leaf, and moving it back into its own was refused");
            });
        }
        const leaf = placement.kind === "none" ? undefined : placement.leaf;
        if (leaf === undefined) {
            if (options.container === true && !said.has("no-leaf") && (await io.read(`${CGROUP_ROOT}/daemon/cgroup.procs`)) === undefined) {
                const mount = cgroupMountOptions((await io.read("/proc/mounts")) ?? "");
                once("no-leaf", () => {
                    logger.warn(
                        { mount: mount ?? "none" },
                        "daemon cgroup: this container has no daemon leaf, so nothing keeps the daemon's heap out of swap and the first requests after a long idle can wait while it pages back in",
                    );
                });
            }
            return;
        }
        const check = await checkDaemonLeaf(leaf, io);
        for (const { file, was } of check.restored) {
            once(`restored:${file}`, () => {
                logger.warn({ leaf, file, was, now: DAEMON_LEAF_SETTINGS.find((setting) => setting.file === file)?.value }, "daemon cgroup: a setting the entrypoint makes was not in place, restored it");
            });
        }
        for (const { file, reason } of check.refused) {
            once(`refused:${file}`, () => {
                logger.warn({ leaf, file, reason }, "daemon cgroup: a setting the entrypoint makes is not in place, and writing it was refused");
            });
        }
        if (check.missing.includes(PROTECTION)) {
            once("missing", () => {
                logger.warn({ leaf }, "daemon cgroup: the leaf has no memory controller, so nothing keeps the daemon's heap out of swap");
            });
        }
        await keepWorkload(leaf.slice(0, leaf.lastIndexOf("/")));
    };
    // Said once per bound and value: a live reshape that changes the swap is a line of its own, a bound something keeps
    // resetting to the same wrong value is one line, not sixty an hour.
    const keepWorkload = async (root: string): Promise<void> => {
        const leaf = `${root}/workload`;
        const check = await checkWorkloadLeaf(root, swapEnv, io);
        for (const { file, was, now } of check.restored) {
            once(`workload:${file}:${now}`, () => {
                logger.info({ leaf, file, was, now }, "workload cgroup: a bound every agent process is held to was not as the sandbox's size asks, set it");
            });
        }
        for (const { file, reason } of check.refused) {
            once(`workload-refused:${file}`, () => {
                logger.warn({ leaf, file, reason }, "workload cgroup: a bound every agent process is held to is not in place, and writing it was refused");
            });
        }
        // Only where the leaf itself is there: one the entrypoint never made has nothing in it to bound.
        if (check.missing.includes("memory.swap.max") && !said.has("workload-missing") && (await io.read(`${leaf}/cgroup.procs`)) !== undefined) {
            once("workload-missing", () => {
                logger.warn({ leaf }, "workload cgroup: the leaf has no swap bound to keep, so a runaway agent process can page the whole machine");
            });
        }
    };
    // allow(silent-catch): a pass that cannot read its own cgroup has nothing to keep; the next one tries again.
    const run = (): void => void pass().catch(() => undefined);
    run();
    const timer = setInterval(run, options.intervalMs ?? 60_000);
    timer.unref();
    return { stop: () => clearInterval(timer) };
};
