import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { CliLauncher } from "./launcher.js";

/* THE RESIDENT BACKGROUND LOOP — one per machine, outliving the terminal that started it, found again across
 * processes through a pidfile.
 *
 * The pidfile is how a later `status`, `--stop` or `uninstall` reaches a loop no shell owns any more. A stale
 * one (the loop crashed, the machine lost power) reads as "not running" rather than as a lie, which is why the
 * pid is probed rather than trusted. */

// Signal 0 tests for the process without touching it: ESRCH means it is gone, EPERM means it exists and belongs
// to another user — which still counts as alive. Exported for the bounded waits that watch one pid exit, where
// re-reading the pidfile would answer a different question.
export const isProcessAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

// The pid in the file, if there is one and it is still running. Undefined covers every other case — no file, a
// half-written one, a pid that has since exited — because they all mean the same thing to every caller.
export const livePid = async (pidPath: string): Promise<number | undefined> => {
    const pid = Number((await readFile(pidPath, "utf8").catch(() => "")).trim());
    if (!Number.isInteger(pid) || pid <= 0) {
        return undefined;
    }
    return isProcessAlive(pid) ? pid : undefined;
};

/* How the loop outlives the command that started it — and the two platforms want OPPOSITE flags.
 *
 * POSIX: `detached` gives it its own session, so the terminal that launched it can't take it down.
 *
 * Windows: `detached` is DETACHED_PROCESS, which leaves the child with NO CONSOLE. Windows then gives every
 * console child of a console-less process a console of its own, and "creating a new console results in a new
 * console window" — so the git → ssh → cloudflared that the sync agent's bridge runs on EVERY tick became three
 * black windows popping up and closing every five seconds, forever, on a machine that was otherwise idle. The
 * host agent hits the same rule with every command its tools run. Windows keeps a child alive after its parent
 * exits by itself, so what is needed here is not detachment but a console with no WINDOW: CREATE_NO_WINDOW,
 * which every descendant inherits and stays invisible in.
 *
 * The two cannot be combined — CREATE_NO_WINDOW "is ignored ... if it is used with either CREATE_NEW_CONSOLE or
 * DETACHED_PROCESS" — so passing both, as this once did, is exactly passing neither. Mutagen meets the same rule
 * from the other side: its daemon IS detached, so it has to spawn every ssh with CREATE_NEW_CONSOLE plus a
 * hidden window (pkg/agent/transport/process_windows.go) to keep them off the screen. */
export const detachedSpawnOptions = (platform: NodeJS.Platform): { readonly detached: true } | { readonly windowsHide: true } =>
    platform === "win32" ? { windowsHide: true } : { detached: true };

// Start the loop detached, its stdout and stderr appended to `logPath` — the only place its output can go once
// no terminal owns it. Answers the child's pid so the caller can say so in its own words.
export const spawnDetached = (logPath: string, launcher: CliLauncher, args: readonly string[]): number | undefined => {
    const logFd = openSync(logPath, "a");
    const [command, ...leading] = launcher;
    const child = spawn(command, [...leading, ...args], {
        ...detachedSpawnOptions(process.platform),
        stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    return child.pid;
};
