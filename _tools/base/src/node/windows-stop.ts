import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { sleep } from "../async.js";

/* ONE WAY TO STOP A PROGRAM ON WINDOWS: ASK, WAIT, THEN FORCE (2026-11-02). Windows has no SIGTERM. Asking a program to
   close means one of two things, depending on what kind of program it is:
   - a program with a window hears WM_CLOSE, which `taskkill` without /F posts, as the window's close button would;
   - a console program has no window, so taskkill answers "This process can only be terminated forcefully" and the
     program hears nothing. Its close button sends a console control event, which only a process on the same console
     can send. `intentic-launch.exe --ctrl-break` (_devices/win-launcher), shipped beside the agent, attaches to the
     program's console and sends CTRL_BREAK_EVENT to everything on it.
   Before this, every stop of a console program was forced: the device agent's app_stop asked through taskkill alone,
   which no console program hears, and the run_command deadline and the sandbox tools' `ic` deadline forced at once.
   A console game server stopped this way lost what it had not saved. Every Windows stop path now asks both ways
   first, waits its grace, and forces only what is still running, and says which way it asked, so a forced stop can
   say whether the program was asked at all. */

const WINDOWS_LAUNCHER = "intentic-launch.exe";

// Beside the running binary, where intentic-machine keeps it (local-agent launcher.ts); never looked up on PATH.
export const windowsLauncher = (execPath: string = process.execPath): string | undefined => {
    if (process.platform !== "win32") {
        return undefined;
    }
    const candidate = join(dirname(execPath), WINDOWS_LAUNCHER);
    return existsSync(candidate) ? candidate : undefined;
};

// How a program was asked to close: through its window, through its console, or not at all (it has neither, or a
// console it shares with the agent, or no launcher was there to send the break).
export type CloseAsked = "window" | "console" | "unasked";

// `intentic-launch --ctrl-break` exit codes (win-launcher src/ctrl_break.rs).
const BREAK_SENT = 0;
const BREAK_HAS_WINDOW = 3;

/** How the root was asked, from the launcher's `--ctrl-break` exit (undefined: no launcher) and taskkill's own exit. */
export const closeAskedBy = (breakCode: number | null | undefined, taskkillCode: number | null): CloseAsked => {
    if (breakCode === BREAK_SENT) {
        return "console";
    }
    if (breakCode === BREAK_HAS_WINDOW) {
        return "window";
    }
    // With no word from the launcher (none here, one too old to know the flag, or one that found no console), taskkill's
    // exit is what is left: 0 only when every process in the tree had a window to post WM_CLOSE to.
    return taskkillCode === 0 ? "window" : "unasked";
};

// The exit of a short helper, never thrown: a helper that cannot start or overruns answers null.
const exitOf = (program: string, args: readonly string[], timeoutMs: number): Promise<number | null> =>
    new Promise((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(program, [...args], { stdio: "ignore", windowsHide: true });
        } catch {
            // allow(silent-catch): a helper that cannot start answers as one that failed; the caller forces after its grace
            resolve(null);
            return;
        }
        const timer = setTimeout(() => {
            child.kill();
            resolve(null);
        }, timeoutMs);
        child.once("error", () => {
            clearTimeout(timer);
            resolve(null);
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });

const TASKKILL_MS = 30_000;
const BREAK_MS = 15_000;

/**
 * Asks `pid` and everything it started to close: WM_CLOSE to every window in the tree, then, unless the program has a
 * window of its own (WM_CLOSE already asked it), a Ctrl-Break on its console. `consoleOf` is the program when `pid` is a
 * launcher standing in for it (app_start's runs: intentic-launch --wait, which has no console of its own). `except` is
 * a process that must not hear the break (the agent asking): when it shares the console, nothing is sent there.
 */
export const askWindowsTreeToClose = async (
    pid: number,
    {
        consoleOf = pid,
        launcher = windowsLauncher(),
        except = process.pid,
    }: { readonly consoleOf?: number; readonly launcher?: string | undefined; readonly except?: number } = {},
): Promise<CloseAsked> => {
    const posted = await exitOf("taskkill", ["/PID", String(pid), "/T"], TASKKILL_MS);
    const broke = launcher === undefined ? undefined : await exitOf(launcher, ["--ctrl-break", String(consoleOf), "--except", String(except)], BREAK_MS);
    return closeAskedBy(broke, posted);
};

/** Ends `pid` and everything it started, at once. A tree already gone is the outcome wanted, so nothing is thrown. */
export const forceWindowsTree = async (pid: number): Promise<void> => {
    await exitOf("taskkill", ["/PID", String(pid), "/T", "/F"], TASKKILL_MS);
};

/** The words for why a stop had to force, for the narration of a stop that was not asked to be forced. */
export const forcedBecause = (asked: CloseAsked, graceMs: number): string => {
    const seconds = Math.round(graceMs / 100) / 10;
    switch (asked) {
        case "window":
            return `it was asked to close (its window was sent WM_CLOSE) and had not finished after ${seconds} s`;
        case "console":
            return `it was asked to close (a Ctrl-Break on its console) and had not finished after ${seconds} s`;
        case "unasked":
            return `it could not be asked: it has no window, and no console a Ctrl-Break could reach (forced after ${seconds} s)`;
    }
};

// How long the Windows sweep of a stopped command's descendants may take; PowerShell's own start is most of it.
export const WINDOWS_SWEEP_TIMEOUT_MS = 15_000;

// Windows has no process group, and by the time spawnSync returns it has already ended the direct child, so
// `taskkill /T` has no root left to walk from. What the child started still names it as its parent, so the sweep walks
// that record instead, and only through processes created since the call began: a pid Windows has since handed to
// something unrelated is not this command's.
export const windowsDescendantSweep = (pid: number, since: number): string =>
    [
        "$ErrorActionPreference='SilentlyContinue'",
        `$since=[DateTime]::Parse('${new Date(since - 1_000).toISOString()}').ToUniversalTime()`,
        "$all=@(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate.ToUniversalTime() -ge $since })",
        `$queue=[System.Collections.Generic.Queue[uint32]]::new(); $queue.Enqueue(${pid})`,
        "while($queue.Count -gt 0){ $parent=$queue.Dequeue(); foreach($p in $all){ if($p.ParentProcessId -eq $parent){ $queue.Enqueue($p.ProcessId); Stop-Process -Id $p.ProcessId -Force } } }",
    ].join("; ");

export const windowsPowershell = (): string => `${process.env["SystemRoot"] ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

export const stopWindowsTree = async (child: ChildProcess, pid: number, killGraceMs: number, startedAt: number | undefined): Promise<void> => {
    const exited = new Promise<void>((resolve) => {
        if (hasExited(child)) {
            resolve();
            return;
        }
        child.once("exit", () => resolve());
    });
    if (!hasExited(child)) {
        await askWindowsTreeToClose(pid);
        await Promise.race([exited, sleep(killGraceMs, { unref: true })]);
    }
    if (!hasExited(child)) {
        await forceWindowsTree(pid);
    } else if (startedAt !== undefined) {
        // The root closed when asked; taskkill /T has no root left to walk from, so what it started is found by the
        // parent id it still names (the sweep runBoundedSync uses) and forced like the rest of a tree past its grace.
        await new Promise<void>((resolve) => {
            spawn(windowsPowershell(), ["-NoProfile", "-NonInteractive", "-Command", windowsDescendantSweep(pid, startedAt)], {
                stdio: "ignore",
                windowsHide: true,
                timeout: WINDOWS_SWEEP_TIMEOUT_MS,
            })
                .once("exit", () => resolve())
                .once("error", () => resolve());
        });
    }
    // The child at least, should taskkill have failed; a no-op once it has done its job.
    child.kill();
};
