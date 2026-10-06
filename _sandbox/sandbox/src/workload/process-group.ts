import type { ChildProcess } from "node:child_process";
import { errnoCode } from "@intentic/base/errors";

// Ending a child the daemon spawned with `detached: true`, which on Linux makes it the leader of a session and a process
// group of its own: everything it forks stays in that group unless it asks to leave, so one signal to the group reaches
// the tree. Killing only the leader (a shell) leaves its children running and holding whatever pipe the daemon reads.

// How long a group gets to exit on SIGTERM before SIGKILL.
export const TERM_GRACE_MS = 3_000;

/** Signals the group `pid` leads; false when it is already gone. Never `-0`, which would be the daemon's own group. */
export const signalGroup = (pid: number, signal: NodeJS.Signals): boolean => {
    if (pid <= 0) {
        return false;
    }
    try {
        process.kill(-pid, signal);
        return true;
    } catch (error) {
        // Already gone is the point; any other refusal leaves running a group the caller believes ended.
        if (errnoCode(error) === "ESRCH") {
            return false;
        }
        throw error;
    }
};

/**
 * SIGTERMs the child's process group and SIGKILLs whatever is left after the grace. The hard kill is called off at
 * `settled` on the child: `exit` for a supervised service, whose leader's exit is the event it waits for; `close` for a
 * command whose output is read, which fires only once every process holding its pipes is gone.
 */
export const killGroup = (child: ChildProcess, graceMs = TERM_GRACE_MS, settled: "exit" | "close" = "exit"): void => {
    const pid = child.pid;
    if (pid === undefined || !signalGroup(pid, "SIGTERM")) {
        return;
    }
    const hardKill = setTimeout(() => {
        try {
            signalGroup(pid, "SIGKILL");
        } catch {
            // allow(silent-catch): EPERM past the grace means the id now names someone else's group, which is not ours to kill.
        }
    }, graceMs);
    hardKill.unref();
    child.once(settled, () => clearTimeout(hardKill));
};
