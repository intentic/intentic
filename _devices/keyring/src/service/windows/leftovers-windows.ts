import { readdir, rm, rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { z } from "zod";
import { runPowerShell } from "../../powershell.js";
import type { Runner } from "../../run.js";
import type { WindowsServicePaths } from "./paths-windows.js";
import { REMOVE_TASK_FOLDER_SCRIPT, taskInput } from "./task-windows.js";

/* WHAT THE PROTECTED KEYRING LEAVES ONCE ITS USER'S SERVICE IS GONE (2026-10-18). `service uninstall` used to put the vault
   back and take the task away, and leave the rest: the service's own copy of the program under bin\, the user's now
   empty vault folder, %ProgramData%\Intentic\Keyring itself, and the \Intentic\ folder in Task Scheduler. All of it is
   shared by every user of the PC who set Passwords up, so it goes only once no other user's marker is left; the user's own
   folder goes when it is empty, which a vault put back leaves it. Run inside the elevated `service uninstall`, the one
   process that may touch any of it. */

// Whether a user other than `sid` still runs the protected keyring here: their marker beside the root. Pure.
export const othersInstalled = (rootNames: readonly string[], sid: string): boolean =>
    rootNames.some((name) => name.toLowerCase().endsWith(".hardened") && name.toLowerCase() !== `${sid}.hardened`.toLowerCase());

const TaskFolderAnswerSchema = z.object({ ok: z.boolean(), removed: z.boolean().optional(), error: z.string().optional() });

// A folder that is not there, or not empty, is "nothing to remove", not a failure.
const removeIfEmpty = async (dir: string): Promise<boolean> => await rmdir(dir).then(() => true, () => false);

/** Sweeps what the service left; answers what went, and what could not with why. Never throws: the vault is already back. */
export const sweepWindowsLeftovers = async (runner: Runner, paths: WindowsServicePaths, sid: string): Promise<{ readonly swept: readonly string[]; readonly left: readonly string[] }> => {
    const swept: string[] = [];
    const left: string[] = [];
    if (await removeIfEmpty(paths.vaultDir)) {
        swept.push(paths.vaultDir);
    }
    const names = await readdir(paths.root).catch((error: Error) => {
        left.push(`${paths.root} (${errorMessage(error)})`);
        return undefined;
    });
    if (names === undefined || othersInstalled(names, sid)) {
        return { swept, left };
    }
    try {
        // The task that ran this program was stopped and unregistered before this: nothing holds it open any more.
        await rm(paths.bin, { recursive: true, force: true });
        swept.push(paths.bin);
    } catch (error) {
        left.push(`${paths.bin} (${errorMessage(error)})`);
    }
    for (const dir of [paths.root, dirname(paths.root)]) {
        // the root, then its Intentic parent, each only when empty
        if (await removeIfEmpty(dir)) {
            swept.push(dir);
        }
    }
    const folder = await runPowerShell(runner, { script: REMOVE_TASK_FOLDER_SCRIPT, input: taskInput(paths, sid), timeoutMs: 60_000 }, TaskFolderAnswerSchema);
    if (folder.ok && folder.answer.removed === true) {
        swept.push(`Task Scheduler ${paths.taskPath}`);
    } else if (!folder.ok || !folder.answer.ok) {
        left.push(`Task Scheduler ${paths.taskPath} (${folder.ok ? (folder.answer.error ?? "no reason given") : folder.reason})`);
    }
    return { swept, left };
};
