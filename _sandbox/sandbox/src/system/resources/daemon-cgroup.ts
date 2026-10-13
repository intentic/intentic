import { readFile, writeFile } from "node:fs/promises";
import type { Logger } from "pino";

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

/** The daemon's leaf, when the entrypoint put it in one: `/proc/self/cgroup`'s path ending in `/daemon` (netd's rule). */
export const daemonLeafOf = (procSelfCgroup: string): string | undefined => {
    const path = procSelfCgroup.split("\n").find((line) => line.startsWith("0::"))?.slice(3).trim();
    return path !== undefined && path.endsWith("/daemon") ? `${CGROUP_ROOT}${path}` : undefined;
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
            refused.push({ file, reason: error instanceof Error ? error.message : String(error) });
        }
    }
    return { restored, refused, missing };
};

export interface DaemonCgroupKeeper {
    readonly stop: () => void;
}

/** Keeps the daemon's leaf as the entrypoint meant it: at boot and every `intervalMs`, said once per file each way. */
export const startDaemonCgroupKeeper = (
    logger: Pick<Logger, "warn" | "info">,
    options: { readonly intervalMs?: number; readonly io?: CgroupFiles } = {},
): DaemonCgroupKeeper => {
    const io = options.io ?? files;
    // Said once a daemon life per file and outcome: a leaf something keeps resetting would otherwise say it every minute.
    const said = new Set<string>();
    const once = (key: string, say: () => void): void => {
        if (!said.has(key)) {
            said.add(key);
            say();
        }
    };
    const pass = async (): Promise<void> => {
        const leaf = daemonLeafOf((await io.read("/proc/self/cgroup")) ?? "");
        if (leaf === undefined) {
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
    };
    // allow(silent-catch): a pass that cannot read its own cgroup has nothing to keep; the next one tries again.
    const run = (): void => void pass().catch(() => undefined);
    run();
    const timer = setInterval(run, options.intervalMs ?? 60_000);
    timer.unref();
    return { stop: () => clearInterval(timer) };
};
