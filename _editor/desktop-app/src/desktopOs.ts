import type { IntenticOsChannel, IntenticOsStatus, IntenticOsUpdateCheck } from "@intentic/sandbox-contract/schemas/intentic-os";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/* INTENTIC OS (src-tauri/src/os.rs runs the OS's own `ic os`): the system this computer runs, when it is Intentic OS,
   and the changes This device makes to it. The answers are ic's JSON (the contract's intentic-os schema). */

/** A change to the OS, as every window hears it named. */
export type OsVerb = `update` | `rollback` | `channel` | `reboot`;

/** How a change ended (os.rs `RunEnd`). */
export interface OsRunEnd {
    readonly verb: OsVerb;
    /** It was to restart this computer into what it staged or queued. */
    readonly apply: boolean;
    /** `done`: ic did it. `failed`: it stopped. `notOs`: ic says this is not Intentic OS. `busy`: another change, or other
     *  work of the app's on this computer, was running, and this one never started. */
    readonly outcome: `done` | `failed` | `notOs` | `busy`;
    readonly code: number | null;
    /** It ran past the app's hour and was stopped. */
    readonly timedOut: boolean;
    /** Why it stopped, in ic's words. */
    readonly reason: string | null;
    readonly log: string | null;
    /** ic ran, so its lines and its end reached every window; false for one refused before it began. */
    readonly ran: boolean;
}

/** One moment of a change, as every window hears it: it began, a line it printed, how it ended. */
export type OsRunEvent =
    | { readonly kind: `started`; readonly verb: OsVerb; readonly apply: boolean; readonly channel: IntenticOsChannel | null }
    | { readonly kind: `line`; readonly verb: OsVerb; readonly stream: `stdout` | `stderr`; readonly text: string }
    | ({ readonly kind: `exit` } & OsRunEnd);

// Null on a computer that is not Intentic OS, which has no card for it; rejects with ic's words when it did not answer.
export const osStatus = async (): Promise<IntenticOsStatus | null> => (await invoke<IntenticOsStatus | null>(`os_status`)) ?? null;
/** Whether a newer image is out on this computer's channel. Downloads nothing. */
export const osUpdateCheck = (): Promise<IntenticOsUpdateCheck> => invoke(`os_update_check`);
// Minutes long, and every ending is an answer; each rejects only when it never ran.
export const osUpdate = (apply: boolean): Promise<OsRunEnd> => invoke(`os_update`, { apply });
export const osRollback = (apply: boolean): Promise<OsRunEnd> => invoke(`os_rollback`, { apply });
export const osReboot = (): Promise<OsRunEnd> => invoke(`os_reboot`);
export const osChannel = (channel: IntenticOsChannel): Promise<OsRunEnd> => invoke(`os_channel`, { channel });
export const onOsRun = (handler: (event: OsRunEvent) => void): Promise<UnlistenFn> =>
    listen<OsRunEvent>(`desktop://os-run`, (event) => handler(event.payload));
