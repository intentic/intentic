import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import type { CliLauncher } from "./launcher.js";

/* THE RESIDENT BACKGROUND LOOP, one per machine, outliving the terminal that started it, found again across
 * processes through a pidfile.
 *
 * The pidfile is how a later `status`, `--stop` or `uninstall` reaches a loop no shell owns any more. A stale
 * one (the loop crashed, the machine lost power) reads as "not running" rather than as a lie, which is why the
 * pid is probed rather than trusted. */

// Signal 0 tests for the process without touching it: ESRCH means it is gone, EPERM means it exists and belongs
// to another user, which still counts as alive. Exported for the bounded waits that watch one pid exit, where
// re-reading the pidfile would answer a different question.
export const isProcessAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

// The pid in the file, if there is one and it is still running. Undefined covers every other case, no file, a
// half-written one, a pid that has since exited, because they all mean the same thing to every caller.
export const livePid = async (pidPath: string): Promise<number | undefined> => {
    const pid = Number((await readFile(pidPath, "utf8").catch(() => "")).trim());
    if (!Number.isInteger(pid) || pid <= 0) {
        return undefined;
    }
    return isProcessAlive(pid) ? pid : undefined;
};

/* How the loop outlives the command that started it, `detached` on every platform, for two different reasons.
 *
 * POSIX: it gives the loop its own session, so the terminal that launched it can't take it down.
 *
 * Windows: WITHOUT it the loop is torn down the instant its parent exits. Measured on the compiled binary, from
 * a native PowerShell parent: the same child that lives on with `detached` is gone within a second without it.
 * That is not a Windows rule, a plain `Start-Process` child survives its parent just fine, it is what our
 * runtime does to a child it still considers its own, and `detached` (DETACHED_PROCESS) is what disowns it.
 *
 * This file used to pass `windowsHide` INSTEAD, and the cost was total: every "connected in the background
 * (pid N)" the host agent ever printed on Windows was a process that no longer existed by the time the user read
 * it, with an empty log beside it and nothing in the sandbox; the sync watcher never ran there at all. The two
 * cannot be combined to get both properties. CREATE_NO_WINDOW "is ignored ... if it is used with either
 * CREATE_NEW_CONSOLE or DETACHED_PROCESS", so passing both is exactly passing `detached` alone.
 *
 * WHAT THAT COSTS, AND WHO PAYS IT. A detached process has no console, and Windows gives every console child of
 * a console-less process a console of its own, "creating a new console results in a new console window". So the
 * git → ssh → cloudflared the sync bridge runs on every tick, and every command the host agent's tools run,
 * would each pop a black window on an idle desktop. The fix is per-spawn rather than inherited: CREATE_NO_WINDOW
 * applies whether or not the PARENT has a console, so every child spawned from inside a loop passes
 * `windowsHide` itself. Interactive commands are the exception and keep the user's console, because that is
 * where their output is meant to land. Mutagen meets the same rule from the other side: its daemon is detached
 * too, so it spawns every ssh with CREATE_NEW_CONSOLE plus a hidden window
 * (pkg/agent/transport/process_windows.go). */

/* How long the loop is given to prove it is really up. The failure this catches is instant, a child that is
 * torn down with its parent is gone within a second, so the window is short enough to sit inside a setup
 * command and long enough that process creation on a busy machine is not mistaken for a crash. */
const SETTLE_MS = 2_000;
const SETTLE_POLL_MS = 100;

/* Start the loop detached, its stdout and stderr appended to `logPath`, the only place its output can go once no
 * terminal owns it. Answers the pid once the loop has SURVIVED the settle window, and throws naming the log when
 * it hasn't.
 *
 * The wait is the whole point. A pid proves only that the OS created a process, and every caller here turns that
 * pid straight into a sentence telling the user their machine is now doing something, which is how a loop that
 * died on startup got reported as a success for as long as it did, on the one platform where it always died. */
export const spawnDetached = async (logPath: string, launcher: CliLauncher, args: readonly string[]): Promise<number> => {
    const logFd = openSync(logPath, "a");
    const [command, ...leading] = launcher;
    const child = spawn(command, [...leading, ...args], { detached: true, stdio: ["ignore", logFd, logFd] });
    child.unref();
    const pid = child.pid;
    if (pid === undefined) {
        throw new Error(`could not start ${command} in the background. Details: ${logPath}`);
    }
    for (let waited = 0; waited < SETTLE_MS; waited += SETTLE_POLL_MS) {
        await setTimeout(SETTLE_POLL_MS);
        if (!isProcessAlive(pid)) {
            throw new Error(`the background loop started and stopped immediately (pid ${pid}). Details: ${logPath}`);
        }
    }
    return pid;
};
