import { access, readFile, writeFile } from "node:fs/promises";
import { setPriority } from "node:os";
import { dirname, join } from "node:path";

/* The daemon is the control plane; every direct child is workload. */
const WORKLOAD_NICE = 10;
const POLL_MS = 250;

export const childPids = (text: string): number[] =>
    text
        .trim()
        .split(/\s+/u)
        .filter((value) => value !== "")
        .map(Number)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);

const CGROUP_ROOT = "/sys/fs/cgroup";

// The daemon's own cgroup from `/proc/self/cgroup`, when the entrypoint gave it one (docker-entrypoint.sh): cgroup2's
// single line names it, and only a leaf called `daemon` is the entrypoint's.
export const daemonCgroupOf = (procSelfCgroup: string): string | undefined => {
    const path = /^0::(\/.*)$/mu.exec(procSelfCgroup)?.[1];
    return path !== undefined && path.endsWith("/daemon") ? path : undefined;
};

// Every process in the daemon's cgroup but the daemon: what it started lands there by inheritance, and belongs with the
// workload, not in the leaf whose memory never swaps.
export const strays = (procs: string, self: number): number[] => childPids(procs).filter((pid) => pid !== self);

// The pair of cgroup.procs files the sweep reads and writes, or undefined where the entrypoint set none up.
const cgroupSweep = async (): Promise<{ readonly daemon: string; readonly workload: string } | undefined> => {
    const own = daemonCgroupOf(await readFile("/proc/self/cgroup", "utf8").catch(() => ""));
    if (own === undefined) {
        return undefined;
    }
    const daemon = join(CGROUP_ROOT, own, "cgroup.procs");
    const workload = join(CGROUP_ROOT, dirname(own), "workload", "cgroup.procs");
    return (await access(workload).then(
        () => true,
        () => false,
    ))
        ? { daemon, workload }
        : undefined;
};

export interface WorkloadPriorityGovernor {
    readonly stop: () => void;
}

export const startWorkloadPriorityGovernor = (): WorkloadPriorityGovernor => {
    if (process.platform !== "linux") {
        return { stop: () => undefined };
    }
    const path = `/proc/self/task/${process.pid}/children`;
    const adjusted = new Set<number>();
    const sweep = cgroupSweep();
    let running = false;
    // One write per process, as cgroup.procs takes them; a process that exits mid-move is no loss.
    const moveStrays = async (): Promise<void> => {
        const files = await sweep;
        if (files === undefined) {
            return;
        }
        for (const pid of strays(await readFile(files.daemon, "utf8"), process.pid)) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- cgroupfs takes one pid per write.
            await writeFile(files.workload, String(pid)).catch(() => undefined);
        }
    };
    const reconcile = async (): Promise<void> => {
        if (running) {
            return;
        }
        running = true;
        try {
            await moveStrays();
            const current = new Set(childPids(await readFile(path, "utf8")));
            for (const pid of adjusted) {
                if (!current.has(pid)) {
                    adjusted.delete(pid);
                }
            }
            for (const pid of current) {
                if (adjusted.has(pid)) {
                    continue;
                }
                try {
                    setPriority(pid, WORKLOAD_NICE);
                    adjusted.add(pid);
                } catch {
                    // The child can exit between procfs and setpriority; the next pass sees the truth.
                }
            }
        } catch {
            // procfs is Linux-specific but may be hidden by a hardened runtime. Priority is an optimization;
            // the daemon continues without it.
        } finally {
            running = false;
        }
    };
    void reconcile();
    const timer = setInterval(() => void reconcile(), POLL_MS);
    timer.unref();
    return { stop: () => clearInterval(timer) };
};
