import { readFile } from "node:fs/promises";
import { setPriority } from "node:os";

/* The daemon is the control plane; every direct child is workload. Provider CLIs are spawned inside SDKs we
 * do not control, so prefixing Bash tool commands left the largest resident children (Claude, Codex, OpenCode)
 * at the daemon's own priority. Linux exposes the current direct-child set in one procfs read. Renice them
 * shortly after spawn; niceness is inherited, so their compilers/tests/subagents follow automatically. */
const WORKLOAD_NICE = 10;
const POLL_MS = 250;

export const childPids = (text: string): number[] =>
    text
        .trim()
        .split(/\s+/u)
        .filter((value) => value !== "")
        .map(Number)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);

export interface WorkloadPriorityGovernor {
    readonly stop: () => void;
}

export const startWorkloadPriorityGovernor = (): WorkloadPriorityGovernor => {
    if (process.platform !== "linux") {
        return { stop: () => undefined };
    }
    const path = `/proc/self/task/${process.pid}/children`;
    const adjusted = new Set<number>();
    let running = false;
    const reconcile = async (): Promise<void> => {
        if (running) {
            return;
        }
        running = true;
        try {
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
