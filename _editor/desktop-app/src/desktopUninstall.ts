import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/* UNINSTALLING INTENTIC FROM THIS COMPUTER (src-tauri/src/uninstall.rs runs `ic uninstall`, device/uninstall/ draws it). */

/** The two outcomes, as ic's wire names them: everything goes, or the sandboxes stay with what keeps them running. */
export type UninstallChoice = `everything` | `keep-sandboxes`;

/** One sandbox or runner ic found here. */
export interface FoundSandbox {
    readonly slug: string;
    readonly kind: `sandbox` | `runner` | (string & {});
    /** `removed`: taken off this computer, still recoverable, and deleted with the rest. `unknown`: docker could not say. */
    readonly state: `running` | `stopped` | `removed` | `unknown` | (string & {});
    readonly bytes: number | null;
}

/** A step an outcome runs, labelled the way the checklist shows it. */
export interface PlanStep {
    readonly step: string;
    readonly label: string;
}

/** `ic uninstall --dry-run --json`: what Intentic has on this computer. */
export interface UninstallInventory {
    readonly version: number;
    readonly os: `windows` | `linux` | `macos` | (string & {});
    readonly sandboxes: readonly FoundSandbox[];
    /** Sandboxes and runners, the recoverable ones included: the number the reader types to delete them. */
    readonly deleteCount: number;
    /** Saved passwords: a keyring vault on this computer. */
    readonly passwords: boolean;
    readonly engine: { readonly bytes: number | null; readonly holdsOthers: boolean } | null;
    readonly agent: { readonly folders: number; readonly distros: readonly string[] } | null;
    readonly app: { readonly version: string | null } | null;
    readonly cacheBytes: number;
    /** What stays whatever is chosen, as a person names it. */
    readonly stays: readonly string[];
    /** Everything Intentic has here, in phrases ("the Intentic app", "3 sandboxes (22 GB)"); absent from an older ic. */
    readonly found?: readonly string[];
    readonly steps: Readonly<Partial<Record<UninstallChoice, readonly PlanStep[]>>>;
}

/** A step of the plan as far as it has got; ic may say a state this does not name, which reads as still to come. */
export type StepState = `pending` | `running` | `done` | `failed` | `skipped`;

export interface UninstallStep {
    readonly step: string;
    readonly label: string;
    readonly state: StepState | (string & {});
    readonly detail: string | null;
}

/** Something that did not come off: what went wrong, and the command that finishes the job. */
export interface UninstallFailure {
    readonly label: string;
    readonly problem: string;
    readonly fix: string | null;
}

export interface UninstallOutcome {
    readonly result: `done` | `partial` | (string & {});
    readonly stays: readonly string[];
    readonly failed: readonly UninstallFailure[];
    readonly code: number | null;
}

/** An uninstall as every window hears it, whole, on each change. */
export interface UninstallProgress {
    readonly choice: UninstallChoice | null;
    readonly steps: readonly UninstallStep[];
    /** Set once ic has exited. */
    readonly outcome: UninstallOutcome | null;
    readonly log: string | null;
}

/** What removing the app itself came to. */
export interface UninstallFinish {
    /** The app is closing. */
    readonly closing: boolean;
    /** The command that removes the app's package, for the reader to run. */
    readonly command: string | null;
    readonly reason: string | null;
}

/** Rejects with a sentence: no ic, one that did not answer, or one that said why it could not look. */
export const uninstallInventory = (): Promise<UninstallInventory> => invoke(`uninstall_inventory`);
/** Minutes long, and every ending is an answer; rejects only when it never ran (busy, no ic). */
export const uninstallRun = (choice: UninstallChoice, confirm: number | null): Promise<UninstallProgress> =>
    invoke(`uninstall_run`, { choice, confirm });
/** The last uninstall in this run of the app, running or ended; null before one has started. */
export const uninstallState = async (): Promise<UninstallProgress | null> => (await invoke<UninstallProgress | null>(`uninstall_state`)) ?? null;
/** Removes the app and quits; `leavePackage` quits without trying the package again. */
export const uninstallFinish = (leavePackage = false): Promise<UninstallFinish> => invoke(`uninstall_finish`, { leavePackage });
export const onUninstall = (handler: (progress: UninstallProgress) => void): Promise<UnlistenFn> =>
    listen<UninstallProgress>(`desktop://uninstall`, (event) => handler(event.payload));
