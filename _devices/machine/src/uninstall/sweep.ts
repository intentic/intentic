import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rename, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { keyringPaths } from "@intentic/keyring";
import { baseDir } from "../config.js";
import { runningAsInstalledAgent } from "../installed.js";
import { agentPath } from "../release.js";
import { holdingBack, keyringSweep, machineSweep, type Sweep, windowsCleanupScript } from "./plan.js";
import type { Tally } from "./tally.js";

/* THE AGENT'S FILES, LAST OF ALL: ~/.intentic/machine and ~/.intentic/keyring, all but the person's data (plan.ts), or
   all of it with --delete-data; each folder itself once empty, and ~/.intentic once nothing else is in it (the rest of
   ~/.intentic is ic's, and never touched here). On Windows a running program cannot delete its own file, nor the folder
   that holds it: the installed agent running this purge is moved to %TEMP% first, and whatever still refuses to go is
   handed to a hidden PowerShell that waits for this process to exit and then removes it, so a person who runs the purge
   alone ends up as clean as one whose `ic uninstall` sweeps after it. */

// Where the agent's binary waits for the rest of a POSIX purge (setAgentAside).
export const asidePath = `${agentPath}.uninstalling`;

/**
 * The agent's binary out of its place before anything stops the agent, so whatever would start it again finds none: the
 * Windows side restarts a distro's agent a second after it stops, through a script that answers "no agent here" when
 * the binary is missing (environments/children.ts), and that distro then leaves its list for good. POSIX only: a running
 * binary renames freely there, and the purge goes on running from it. The person can still finish a purge that stopped
 * half-way by running it from here.
 */
export const setAgentAside = async (): Promise<void> => {
    if (process.platform !== "win32" && existsSync(agentPath)) {
        await rename(agentPath, asidePath);
    }
};

export interface SweptFiles {
    // The person's data found in each folder, relative to it: kept, or deleted with the rest under --delete-data.
    readonly machineData: readonly string[];
    readonly keyringData: readonly string[];
    // The folders that were there to sweep.
    readonly folders: readonly string[];
    // What could not go now and does not go after this process either.
    readonly stuck: readonly string[];
    // What goes once this process has exited (Windows).
    readonly afterExit: readonly string[];
}

const namesIn = async (dir: string): Promise<readonly string[]> => (await readdir(dir).catch(undefinedIfMissing)) ?? [];

const removeNames = async (dir: string, sweep: Sweep): Promise<readonly string[]> => {
    const failed: string[] = [];
    for (const name of sweep.remove) {
        const path = join(dir, name);
        try {
            // one at a time, so a refusal names its own path
            await rm(path, { recursive: true, force: true, maxRetries: 3 });
        } catch {
            // allow(silent-catch): the path itself is the answer; it is tried again after exit or named in the stop
            failed.push(path);
        }
    }
    return failed;
};

// An empty folder goes; one with anything in it (the data kept, somebody else's file) stays as it is.
const removeIfEmpty = async (dir: string): Promise<void> => {
    // allow(silent-catch): ENOTEMPTY and ENOENT are both "leave it", which is all this decides
    await rmdir(dir).catch(() => undefined);
};

// The installed agent running this purge, moved where Windows lets a running program go: %TEMP%, on the profile's own
// drive, removed after exit. Undefined when this process is not that binary, or it would not move (then it stays in
// bin\ and goes with the after-exit cleanup instead).
const moveSelfAside = async (): Promise<string | undefined> => {
    if (process.platform !== "win32" || !runningAsInstalledAgent()) {
        return undefined;
    }
    const aside = join(tmpdir(), `intentic-machine-uninstalled-${process.pid}.exe`);
    try {
        await rename(agentPath, aside);
        return aside;
    } catch {
        // allow(silent-catch): it stays in bin\, whose removal fails and is handed to the after-exit cleanup
        return undefined;
    }
};

// Started hidden and detached, so it outlives this process and holds none of its pipes (a caller reading this run's
// output, `ic uninstall`, sees it end); the script travels base64-encoded, past every quoting rule on the way. Answers
// why it could not start, or undefined once it has.
const scheduleAfterExit = async (paths: readonly string[], emptyDirs: readonly string[]): Promise<string | undefined> => {
    const encoded = Buffer.from(windowsCleanupScript(process.pid, paths, emptyDirs), "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
    });
    const started = await new Promise<string | undefined>((resolve) => {
        child.once("spawn", () => resolve(undefined));
        child.once("error", (error) => resolve(errorMessage(error)));
    });
    child.unref();
    return started;
};

/** Sweeps both folders; `holdBin` keeps the binaries a step that did not finish still needs (a hardened keyring). */
export const sweepAgentFiles = async (deleteData: boolean, holdBin: boolean, say: Tally): Promise<SweptFiles> => {
    const movedSelf = holdBin ? undefined : await moveSelfAside();
    const keyringDir = keyringPaths().dir;
    const [machineNames, trashNames, keyringNames] = [await namesIn(baseDir), await namesIn(join(baseDir, "trash")), await namesIn(keyringDir)];
    const machinePlan = machineSweep(machineNames, trashNames, deleteData);
    const machine = holdBin ? holdingBack(machinePlan, ["bin"]) : machinePlan;
    const keyring = keyringSweep(keyringNames, deleteData);
    const data = {
        machineData: machineSweep(machineNames, trashNames, false).keep,
        keyringData: keyringSweep(keyringNames, false).keep,
        folders: [...(machineNames.length > 0 ? [baseDir] : []), ...(keyringNames.length > 0 ? [keyringDir] : [])],
    };
    const failed = [...(await removeNames(baseDir, machine)), ...(await removeNames(keyringDir, keyring))];
    const home = dirname(baseDir);
    for (const dir of [join(baseDir, "trash"), baseDir, keyringDir, home]) {
        // inner folders first: each may be empty only once the one inside it went
        await removeIfEmpty(dir);
    }
    const afterExit = [...failed, ...(movedSelf === undefined ? [] : [movedSelf])];
    if (process.platform !== "win32" || afterExit.length === 0) {
        return { ...data, stuck: failed, afterExit: [] };
    }
    const refused = await scheduleAfterExit(afterExit, [join(baseDir, "trash"), baseDir, keyringDir, home]);
    if (refused !== undefined) {
        say.note(`The cleanup that runs once this program exits could not be started (${refused}).`);
        return { ...data, stuck: failed, afterExit: [] };
    }
    return { ...data, stuck: [], afterExit };
};
