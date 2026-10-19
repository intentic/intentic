import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { writeFileAtomic } from "@intentic/base/fs";
import { z } from "zod";
import { keyringPaths } from "../address.js";
import { runPowerShell } from "../powershell.js";
import type { Runner } from "../run.js";
import { hardenedAcls, type IcaclsCall, markerAcl } from "./acl.js";
import { sweepHardenedLeftovers } from "./leftovers.js";
import { hardenedPaths } from "./paths.js";
import { currentSid } from "./sid.js";
import { REGISTER_TASK_SCRIPT, STOP_TASK_SCRIPT, taskInput, UNREGISTER_TASK_SCRIPT } from "./task.js";

// `intentic-keyring service install|uninstall`, run elevated (intentic-machine's `keyring harden` asks Windows for the
// one UAC yes). Install puts the service's own copy of the keyring where only an administrator can replace it, moves the
// user's vault into the folder only the service can read, and registers the task that runs it at startup; run again,
// it replaces the program and restarts the task, keeping the vault. Uninstall puts the vault back in the user's own
// folder and removes the task. The plain keyring must not be running meanwhile: intentic-machine stops it first.

const VAULT_FILES = ["vault.json", "keys.json", "audit.jsonl"] as const;
const TaskAnswerSchema = z.object({ ok: z.boolean(), error: z.string().optional() });

const exists = async (path: string): Promise<boolean> => await stat(path).then(() => true, () => false);

const icacls = async (runner: Runner, call: IcaclsCall): Promise<void> => {
    const answer = await runner({ command: "icacls", args: [call.path, ...call.args], timeoutMs: 30_000 });
    if (answer.exitCode !== 0) {
        throw new Error(`icacls ${call.path} failed (exit ${String(answer.exitCode)}): ${answer.stdout.trim() || answer.stderr.trim()}`);
    }
};

// Copied, not moved: a moved file keeps the access list it had in the user's profile, a copied one takes its new folder's.
const carry = async (from: string, to: string): Promise<boolean> => {
    if (!(await exists(from))) {
        return false;
    }
    await copyFile(from, to);
    await rm(from, { force: true });
    return true;
};

export const installService = async (runner: Runner, program: string = process.execPath): Promise<{ readonly sid: string; readonly moved: readonly string[] }> => {
    if (!basename(program).toLowerCase().startsWith("intentic-keyring")) {
        throw new Error("Hardened mode installs the compiled keyring itself: run it as intentic-keyring.exe.");
    }
    const sid = await currentSid(runner);
    const paths = hardenedPaths(sid);
    await mkdir(paths.bin, { recursive: true });
    await mkdir(paths.vaultDir, { recursive: true });
    for (const call of hardenedAcls(paths)) {
        await icacls(runner, call);
    }
    // A running task holds the old program open: stopped (and started again below) so the copy can land.
    await runPowerShell(runner, { script: STOP_TASK_SCRIPT, input: taskInput(paths, sid), timeoutMs: 60_000 }, TaskAnswerSchema);
    await copyFile(program, paths.exe);
    const own = keyringPaths();
    const moved: string[] = [];
    if (!(await exists(join(paths.vaultDir, "vault.json")))) {
        for (const name of VAULT_FILES) {
            if (await carry(join(own.dir, name), join(paths.vaultDir, name))) {
                moved.push(name);
            }
        }
    }
    // Children take the folder's list, whatever they were created with. A failure stops the install: a vault file left
    // with the user's own access list is the one thing hardened mode exists to prevent. An empty folder has no children
    // to reset, and icacls refuses a wildcard that matches nothing.
    if ((await readdir(paths.vaultDir)).length > 0) {
        await icacls(runner, { path: join(paths.vaultDir, "*"), args: ["/reset"] });
    }
    await writeFileAtomic(paths.marker, `${JSON.stringify({ installedAt: new Date().toISOString(), sid })}\n`, 0o644);
    await icacls(runner, markerAcl(paths.marker));
    const registered = await runPowerShell(runner, { script: REGISTER_TASK_SCRIPT, input: taskInput(paths, sid), timeoutMs: 60_000 }, TaskAnswerSchema);
    if (!registered.ok || !registered.answer.ok) {
        throw new Error(`The service's task could not be registered: ${registered.ok ? (registered.answer.error ?? "no reason given") : registered.reason}`);
    }
    return { sid, moved };
};

// The vault back in the user's own folder and the task gone; then what the service left, once nobody else uses it
// (leftovers.ts). `left` names what stays, with why: an answer to read, never a reason to fail what already happened.
export const uninstallService = async (
    runner: Runner,
): Promise<{ readonly sid: string; readonly restored: readonly string[]; readonly swept: readonly string[]; readonly left: readonly string[] }> => {
    const sid = await currentSid(runner);
    const paths = hardenedPaths(sid);
    await runPowerShell(runner, { script: UNREGISTER_TASK_SCRIPT, input: taskInput(paths, sid), timeoutMs: 60_000 }, TaskAnswerSchema);
    const own = keyringPaths();
    await mkdir(own.dir, { recursive: true });
    const restored: string[] = [];
    for (const name of VAULT_FILES) {
        if (!(await exists(join(own.dir, name))) && (await carry(join(paths.vaultDir, name), join(own.dir, name)))) {
            restored.push(name);
        }
    }
    await rm(paths.marker, { force: true });
    await rm(paths.door, { force: true });
    return { sid, restored, ...(await sweepHardenedLeftovers(runner, paths, sid)) };
};
