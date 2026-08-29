import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { uptime } from "node:os";
import { basename } from "node:path";
import { setTimeout } from "node:timers/promises";
import { type CliLauncher, stubCommand, windowsLaunchStub } from "./launcher.js";

/* THE RESIDENT BACKGROUND LOOP, one per machine, outliving the terminal that started it, found again across
 * processes through a pidfile.
 *
 * The pidfile is how a later `status`, `--stop` or `uninstall` reaches a loop no shell owns any more. A stale
 * one (the loop crashed, the machine lost power) must read as "not running" rather than as a lie, which is why
 * the pid is probed rather than trusted, and why the pid alone is not what is written (`bootToken`). */

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

/* WHAT A PID CANNOT SAY ON ITS OWN, AND THE OUTAGE THAT PROVED IT.
 *
 * A pidfile lives in `~/.intentic/<name>`, so it outlives the boot that wrote it. Probing the number in it
 * answers "is SOMETHING running under this pid", never "is the loop that wrote this still running", and across a
 * reboot those are different questions: pids restart low and are handed out in roughly the same order every
 * time, so the number a loop held at boot N is, at the same moment of boot N+1, held by whatever unrelated
 * early-boot process reached it first.
 *
 * FIELD FAILURE, 2026-08-29. The machine bugchecked in standby (a display driver, nothing to do with us), so
 * nothing ran the shutdown path that removes the pidfile. It still said 232. On the next boot the sync watcher's
 * own systemd unit came up as pid 216, probed 232, found a transient early-boot process wearing it, and refused
 * to start: "a mirror watcher is already running (pid 232)". Refusing is a CHOICE, so it exits 0 on purpose (a
 * supervisor must not restart a watcher into refusing again every RestartSec, see mirror.ts `signalExitCode`),
 * which means `Restart=on-failure` never fired. Pid 232 was gone within seconds. The refusal lasted until a
 * person went looking, and desktop file sync was off for the whole of it.
 *
 * So the pidfile records the BOOT it was written in, and a record from any other boot is stale by construction:
 * the pid in it describes a process table that no longer exists, and is never probed. */
const bootToken = async (): Promise<string> => {
    /* Linux (and WSL) publishes a fresh UUID per boot. Exact, free to read, and immune to the clock moving,
     * which matters on the machines this bit: a WSL guest resuming behind a host that slept spends its first
     * minutes being stepped by the hypervisor's time sync. */
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "")).trim();
    /* Elsewhere the boot is named by WHEN it started, which is the same fact by subtraction. libuv's uptime is
     * `GetTickCount64` on Windows and `kern.boottime` on macOS, and both keep counting across sleep, so a laptop
     * that suspends and resumes goes on answering the same boot rather than looking like a new one. */
    return bootId === "" ? `at:${Math.round(Date.now() - uptime() * 1000)}` : `id:${bootId}`;
};

/* How far two DERIVED boot stamps may sit apart and still be one boot. Only the `at:` form needs a tolerance:
 * it is anchored to `Date.now()`, so stepping the clock (an NTP correction, a VM resuming on a stale RTC) moves
 * it while the uptime keeps counting. A false MISMATCH is the expensive direction, it would let a second loop
 * start on top of a live one, and two of those do real damage rather than merely wasting a process. Two minutes
 * is far above any correction a running machine takes in one step and far below what a real reboot costs. `id:`
 * stamps are exact and compared exactly. */
const SAME_BOOT_MS = 120_000;

const sameBoot = (written: string, current: string): boolean => {
    if (!written.startsWith("at:") || !current.startsWith("at:")) {
        return written === current;
    }
    return Math.abs(Number(written.slice(3)) - Number(current.slice(3))) <= SAME_BOOT_MS;
};

/* What every writer puts in its pidfile: the process, and the boot it belongs to. One producer so `livePid` has
 * one shape to parse. The pid is a parameter only so a test can write a record for a stand-in process it
 * spawned; every real caller writes its own. */
export const pidFileBody = async (pid: number = process.pid): Promise<string> => `${pid} ${await bootToken()}`;

// The pid in the file, if the file was written by THIS boot and that pid is still running. Undefined covers
// every other case, no file, a half-written one, one left behind by an earlier boot, a pid that has since
// exited, because they all mean the same thing to every caller: there is no loop to reach.
export const livePid = async (pidPath: string): Promise<number | undefined> => {
    const [written = "", stamp = ""] = (await readFile(pidPath, "utf8").catch(() => "")).trim().split(/\s+/);
    const pid = Number(written);
    if (!Number.isInteger(pid) || pid <= 0) {
        return undefined;
    }
    if (!sameBoot(stamp, await bootToken())) {
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
 * (pkg/agent/transport/process_windows.go).
 *
 * THE LAUNCHER STUB CHANGES THAT BARGAIN, and it is why Windows now has a path of its own below. A loop started
 * through `intentic-launch.exe` gets CREATE_NO_WINDOW instead of DETACHED_PROCESS: a console of its own with no
 * window on it, which the OS hands down to every console child it spawns. The per-spawn `windowsHide` stays —
 * it is still the only thing covering a loop somebody started the other way — but it stops being the single
 * point of failure between a user and a black window. The stub is spawned `detached` for the reason above: it
 * must not be a job-object member, or the loop it starts dies with the command that asked for it. */

/* How long the loop is given to prove it is really up. The failure this catches is instant, a child that is
 * torn down with its parent is gone within a second, so the window is short enough to sit inside a setup
 * command and long enough that process creation on a busy machine is not mistaken for a crash. */
const SETTLE_MS = 2_000;
const SETTLE_POLL_MS = 100;

// How long the stub is given to answer with a pid. It starts one process and exits — milliseconds — so this is
// not a budget, it is the difference between a wrong file at that path wedging `setup` forever and one failure
// that names the file.
const STUB_REPLY_MS = 10_000;

// Start the loop ourselves, the way every platform without a stub does it.
const spawnHere = (logPath: string, launcher: CliLauncher, args: readonly string[]): number => {
    const logFd = openSync(logPath, "a");
    const [command, ...leading] = launcher;
    const child = spawn(command, [...leading, ...args], { detached: true, stdio: ["ignore", logFd, logFd] });
    child.unref();
    if (child.pid === undefined) {
        throw new Error(`could not start ${command} in the background. Details: ${logPath}`);
    }
    return child.pid;
};

/* Start it through the Windows stub, whose stdout carries the pid of what it started. That pid is the whole
 * reason this reads a pipe rather than firing and forgetting: the stub's OWN pid belongs to a process that is
 * already gone, and handing that to the settle loop below would report a dead launcher as a dead agent every
 * single time. A stub that fails has already written the reason into the log; what is on its stderr is a
 * malformed command line, which is ours, so both are worth carrying into the error. */
const spawnThroughStub = async (stub: string, logPath: string, launcher: CliLauncher, args: readonly string[]): Promise<number> => {
    const [command, ...rest] = stubCommand(stub, logPath, [...launcher, ...args]);
    const child = spawn(command, rest, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let answered = "";
    let complained = "";
    child.stdout?.on("data", (chunk: Buffer) => (answered += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (complained += chunk.toString()));
    const status = await new Promise<number | null>((resolve, reject) => {
        const timer = globalThis.setTimeout(() => {
            child.kill();
            reject(new Error(`${basename(stub)} did not answer within ${STUB_REPLY_MS}ms. Details: ${logPath}`));
        }, STUB_REPLY_MS);
        timer.unref();
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });
    const pid = Number(answered.trim());
    if (status !== 0 || !Number.isInteger(pid) || pid <= 0) {
        const said = complained.trim();
        throw new Error(`${basename(stub)} could not start the background loop${said === "" ? "" : `: ${said}`}. Details: ${logPath}`);
    }
    return pid;
};

/* Start the loop in the background, its stdout and stderr appended to `logPath`, the only place its output can
 * go once no terminal owns it. Answers the pid once the loop has SURVIVED the settle window, and throws naming
 * the log when it hasn't.
 *
 * The wait is the whole point. A pid proves only that the OS created a process, and every caller here turns that
 * pid straight into a sentence telling the user their machine is now doing something, which is how a loop that
 * died on startup got reported as a success for as long as it did, on the one platform where it always died. */
export const spawnDetached = async (logPath: string, launcher: CliLauncher, args: readonly string[]): Promise<number> => {
    const stub = windowsLaunchStub(launcher);
    const pid = stub === undefined ? spawnHere(logPath, launcher, args) : await spawnThroughStub(stub, logPath, launcher, args);
    for (let waited = 0; waited < SETTLE_MS; waited += SETTLE_POLL_MS) {
        await setTimeout(SETTLE_POLL_MS);
        if (!isProcessAlive(pid)) {
            throw new Error(`the background loop started and stopped immediately (pid ${pid}). Details: ${logPath}`);
        }
    }
    return pid;
};
