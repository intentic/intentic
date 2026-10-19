import { isInside } from "../upkeep/trash.js";

/* WHAT `uninstall --purge` DECIDES, pure over what it read: which flags mean what, which of the agent's files are the
   person's data, whether lingering is the agent's to turn off, how a distro's purge ended, and the script that finishes
   on Windows once this process has exited. The removals themselves are purge.ts and its neighbours. */

export interface PurgeChoice {
    readonly purge: boolean;
    readonly deleteData: boolean;
}

// --delete-data implies --purge: deleting the data while leaving the agent that wrote it would be no uninstall at all.
export const purgeChoice = (flags: { readonly purge?: boolean; readonly deleteData?: boolean }): PurgeChoice => ({
    purge: flags.purge === true || flags.deleteData === true,
    deleteData: flags.deleteData === true,
});

// A folder `trash_file` made for a file a sandbox moved aside on this device (device/tools/files.ts): named for the
// moment alone. The upkeep's own trash entries carry the name of what they hold after the stamp (upkeep/trash.ts).
const SANDBOX_TRASH = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/u;

// The person's data in ~/.intentic/machine: restore points of their synced folders, the record of what this agent did,
// and the trash, as far as it holds files of theirs that a sandbox moved there (theirs to get back, not the agent's).
const machineDataName = (name: string): boolean => name === "restore" || name.startsWith("audit.jsonl");
export const sandboxTrashName = (name: string): boolean => SANDBOX_TRASH.test(name);

// The person's data in ~/.intentic/keyring: the vault, the keys that open it, and its record (the keyring's VAULT_FILES).
const keyringDataName = (name: string): boolean => name === "vault.json" || name === "keys.json" || name.startsWith("audit.jsonl");

// One folder's names, relative to it: what goes and what stays.
export interface Sweep {
    readonly remove: readonly string[];
    readonly keep: readonly string[];
}

const TRASH = "trash";

/** ~/.intentic/machine: everything but its data, or everything with `deleteData`; `trash` is judged entry by entry. */
export const machineSweep = (names: readonly string[], trashNames: readonly string[], deleteData: boolean): Sweep => {
    if (deleteData) {
        return { remove: [...names], keep: [] };
    }
    const remove: string[] = [];
    const keep: string[] = [];
    for (const name of names) {
        if (machineDataName(name)) {
            keep.push(name);
        } else if (name === TRASH && trashNames.some(sandboxTrashName)) {
            keep.push(...trashNames.filter(sandboxTrashName).map((entry) => `${TRASH}/${entry}`));
            remove.push(...trashNames.filter((entry) => !sandboxTrashName(entry)).map((entry) => `${TRASH}/${entry}`));
        } else {
            remove.push(name);
        }
    }
    return { remove, keep };
};

/** ~/.intentic/keyring: everything but the vault, its keys and its record, or everything with `deleteData`. */
export const keyringSweep = (names: readonly string[], deleteData: boolean): Sweep =>
    deleteData ? { remove: [...names], keep: [] } : { remove: names.filter((name) => !keyringDataName(name)), keep: names.filter(keyringDataName) };

/** A sweep with some names held back (the binaries a step that failed still needs to be finished with). */
export const holdingBack = (sweep: Sweep, held: readonly string[]): Sweep => ({
    remove: sweep.remove.filter((name) => !held.includes(name)),
    keep: [...sweep.keep, ...sweep.remove.filter((name) => held.includes(name))],
});

// What becomes of lingering: off already, the user's own (on with no marker of the agent's), the agent's to turn off,
// or not readable here.
export type LingerAction = "off" | "theirs" | "disable" | "unknown";

export const lingerAction = (markerFound: boolean, lingering: boolean | undefined): LingerAction => {
    if (lingering === undefined) {
        return "unknown";
    }
    if (!lingering) {
        return "off";
    }
    return markerFound ? "disable" : "theirs";
};

// What a distro's agent answers to `uninstall --purge`: its own exit code, crossed through wsl.exe. 64 is the script's
// own "no agent there" (environments/crossing.ts NO_AGENT_EXIT); 252 is stricli's refusal of a flag it does not know
// (ExitCode.InvalidArgument, -4), which is an agent older than --purge.
const DISTRO_NO_AGENT_EXIT = 64;
const DISTRO_UNKNOWN_FLAG_EXIT = 252;

export type DistroOutcome = "purged" | "no-agent" | "older" | "failed";

export const distroOutcome = (code: number | null): DistroOutcome => {
    if (code === 0) {
        return "purged";
    }
    if (code === DISTRO_NO_AGENT_EXIT) {
        return "no-agent";
    }
    return code === DISTRO_UNKNOWN_FLAG_EXIT ? "older" : "failed";
};

// Whether a link on PATH is this agent's: it points at the agent's binary or anywhere in its bin folder. A dangling link
// still says where it pointed; one pointing anywhere else is somebody else's.
export const linkIsOurs = (target: string | undefined, agentPath: string, binDir: string): boolean =>
    target !== undefined && (target === agentPath || isInside(target, binDir));

// A PowerShell string literal: single quotes, each one inside doubled.
const psQuoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/**
 * What finishes a purge on Windows once this process has gone: a running program cannot delete its own file, nor a
 * folder that holds it. Waits for `pid` (two minutes at most), removes `paths` (tried for a while, since a process that
 * held one may be a moment behind), then each of `emptyDirs` that is empty, in order (inner folders first).
 */
export const windowsCleanupScript = (pid: number, paths: readonly string[], emptyDirs: readonly string[]): string =>
    [
        "$ErrorActionPreference = 'SilentlyContinue'",
        `Wait-Process -Id ${pid} -Timeout 120`,
        `$paths = @(${paths.map(psQuoted).join(", ")})`,
        "for ($i = 0; $i -lt 15; $i++) {",
        "  foreach ($p in $paths) { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force } }",
        "  if (-not ($paths | Where-Object { Test-Path -LiteralPath $_ })) { break }",
        "  Start-Sleep -Seconds 2",
        "}",
        `foreach ($d in @(${emptyDirs.map(psQuoted).join(", ")})) {`,
        "  if ((Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force)) { Remove-Item -LiteralPath $d -Force }",
        "}",
    ].join("\n");
