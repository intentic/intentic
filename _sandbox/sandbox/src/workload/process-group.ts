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

// SIGKILL to the group `pid` led, once the grace is up; the caller calls it off when the group is known gone.
const hardKillAfter = (pid: number, graceMs: number): ReturnType<typeof setTimeout> => {
    const hardKill = setTimeout(() => {
        try {
            signalGroup(pid, "SIGKILL");
        } catch {
            // allow(silent-catch): EPERM past the grace means the id now names someone else's group, which is not ours to kill.
        }
    }, graceMs);
    hardKill.unref();
    return hardKill;
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
    const hardKill = hardKillAfter(pid, graceMs);
    child.once(settled, () => clearTimeout(hardKill));
};

// What stopTree needs of a child: a ChildProcess, or the narrower stand-in a runtime's seam declares.
export interface TreeLeader {
    readonly pid?: number | undefined;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    kill(signal: NodeJS.Signals): boolean;
    once(event: "close", listener: () => void): void;
}

/**
 * Stops an agent runtime and everything it started (an `npx` wrapper's real agent, the MCP servers that agent spawned),
 * for a child spawned `detached`, which leads a process group: SIGTERM to the group, then SIGKILL to it after the grace
 * unless every process holding its pipes is gone by then (`close`). A child that leads no group (one spawned without
 * `detached`, or a test's stand-in) is sent SIGTERM alone, so the caller need not know how it was started. Safe to call
 * again, and on a leader that already exited: whatever is left of its group still gets the signals.
 */
export const stopTree = (child: TreeLeader, graceMs = TERM_GRACE_MS): void => {
    const pid = child.pid;
    if (pid !== undefined && signalGroup(pid, "SIGTERM")) {
        const hardKill = hardKillAfter(pid, graceMs);
        child.once("close", () => clearTimeout(hardKill));
        return;
    }
    if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
    }
};
