import type {
    IntenticOsDisplayList,
    IntenticOsDisplayMode,
    IntenticOsDrive,
    IntenticOsDriveImport,
    IntenticOsKeyboardLayouts,
    IntenticOsKeyboardStatus,
    IntenticOsNetworkStatus,
    IntenticOsSoundOutputs,
    IntenticOsSoundStatus,
    IntenticOsWifiList,
} from "@intentic/sandbox-contract/schemas/intentic-os";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/* THIS COMPUTER'S SETTINGS, ON INTENTIC OS: the screen lock (src-tauri/src/shell/lock.rs) and the network, sound, screens,
   keyboard and drives (src-tauri/src/os_settings.rs), each a Tauri command running `ic os … --json`. Beside desktop.ts
   rather than in it, which holds the app's other commands and is past the size a reader takes in at once. */

export interface OsLockStatus {
    readonly enabled: boolean;
    readonly idleMinutes: number;
}

export const osLockStatus = (): Promise<OsLockStatus | null> => invoke(`os_lock_status`);
/** The PIN is sent to ic on standard input, never on its command line. */
export const osLockSetPin = (pin: string): Promise<OsLockStatus> => invoke(`os_lock_set_pin`, { pin });
export const osLockOff = (): Promise<OsLockStatus> => invoke(`os_lock_off`);
export const osLockIdle = (minutes: number): Promise<OsLockStatus> => invoke(`os_lock_idle`, { minutes });
/* INTENTIC OS'S OWN SETTINGS (src-tauri/src/os_settings.rs runs `ic os network|sound|display|keyboard|drives`): what This
   computer's cards show and change. Each read is null where ic says this is not Intentic OS, and the screen's and the
   keyboard's on an edition with no screen: the card hides. Each change rejects with ic's words when it was not made. */

/** How joining a Wi-Fi network went: `needsPassword` asks the person for one, `wrongPassword` for it again. */
export interface OsWifiJoin {
    readonly outcome: `joined` | `needsPassword` | `wrongPassword` | `failed` | `notOs`;
    readonly reason: string | null;
}

export const osNetworkStatus = async (): Promise<IntenticOsNetworkStatus | null> => (await invoke<IntenticOsNetworkStatus | null>(`os_network_status`)) ?? null;
/** Rescans first: a few seconds. */
export const osWifiList = async (): Promise<IntenticOsWifiList | null> => (await invoke<IntenticOsWifiList | null>(`os_wifi_list`)) ?? null;
// The password reaches ic on its stdin, never its command line.
export const osWifiConnect = (ssid: string, password?: string): Promise<OsWifiJoin> => invoke(`os_wifi_connect`, { ssid, password: password ?? null });
export const osWifiForget = (ssid: string): Promise<void> => invoke(`os_wifi_forget`, { ssid });
export const osWifiRadio = (on: boolean): Promise<void> => invoke(`os_wifi_radio`, { on });
export const osSoundStatus = async (): Promise<IntenticOsSoundStatus | null> => (await invoke<IntenticOsSoundStatus | null>(`os_sound_status`)) ?? null;
/** The status after the change, or null where ic printed none the app could read. */
export const osSoundSet = async (change: { readonly volume?: number; readonly muted?: boolean }): Promise<IntenticOsSoundStatus | null> =>
    (await invoke<IntenticOsSoundStatus | null>(`os_sound_set`, { volume: change.volume ?? null, muted: change.muted ?? null })) ?? null;
export const osSoundOutputs = async (): Promise<IntenticOsSoundOutputs | null> => (await invoke<IntenticOsSoundOutputs | null>(`os_sound_outputs`)) ?? null;
export const osSoundOutput = (id: number): Promise<void> => invoke(`os_sound_output`, { id });
export const osDisplayList = async (): Promise<IntenticOsDisplayList | null> => (await invoke<IntenticOsDisplayList | null>(`os_display_list`)) ?? null;
export const osDisplaySet = (output: string, change: { readonly mode?: IntenticOsDisplayMode; readonly scale?: number }): Promise<void> =>
    invoke(`os_display_set`, { output, mode: change.mode ?? null, scale: change.scale ?? null });
export const osKeyboardStatus = async (): Promise<IntenticOsKeyboardStatus | null> => (await invoke<IntenticOsKeyboardStatus | null>(`os_keyboard_status`)) ?? null;
/** Every layout the system knows, about 40 KB: read when the picker first opens. */
export const osKeyboardLayouts = async (): Promise<IntenticOsKeyboardLayouts | null> => (await invoke<IntenticOsKeyboardLayouts | null>(`os_keyboard_layouts`)) ?? null;
export const osKeyboardSet = (layout: string, variant?: string): Promise<void> => invoke(`os_keyboard_set`, { layout, variant: variant ?? null });

/** The drives plugged in, and the devices of those plugged in since the reader last looked at the Drives card. */
export interface OsDrivesSeen {
    readonly drives: readonly IntenticOsDrive[];
    readonly fresh: readonly string[];
}

/** A drive's notification in the reader's words: `{name}` is its label, else its model. */
export interface OsDriveWords {
    readonly usbNamed: string;
    readonly usb: string;
    readonly cardNamed: string;
    readonly card: string;
    readonly otherNamed: string;
    readonly other: string;
    readonly body: string;
}

/** How a copy off a drive ended (os_settings.rs `ImportEnd`). */
export interface OsDriveImportEnd {
    readonly device: string;
    readonly sandbox: string;
    /** `noRoom`: it would not fit, and nothing was copied; `stopped`: the reader stopped it; `busy`: another copy was
     *  running, and this one never started. */
    readonly outcome: `done` | `noRoom` | `stopped` | `failed` | `notOs` | `busy`;
    readonly copied: IntenticOsDriveImport | null;
    readonly code: number | null;
    readonly timedOut: boolean;
    /** Why it stopped, in ic's words: for `noRoom`, how much it needs and how much is free. */
    readonly reason: string | null;
    readonly log: string | null;
    readonly ran: boolean;
}

/** One moment of a copy, as every window hears it. */
export type OsDriveImportEvent =
    | { readonly kind: `started`; readonly device: string; readonly sandbox: string }
    | { readonly kind: `progress`; readonly device: string; readonly sandbox: string; readonly bytes: number; readonly total: number }
    | ({ readonly kind: `exit` } & OsDriveImportEnd);

/** The run a copy streams under, which `runStop` stops. */
export const OS_DRIVE_IMPORT_RUN = `os-drive-import`;

/** As the app's watcher last read them; read now where it has not yet. */
export const osDrivesList = async (): Promise<OsDrivesSeen | null> => (await invoke<OsDrivesSeen | null>(`os_drives_list`)) ?? null;
export const osDrivesSeen = (devices: readonly string[]): Promise<void> => invoke(`os_drives_seen`, { devices });
export const osDriveWords = (words: OsDriveWords): Promise<void> => invoke(`os_drive_words`, { words });
// As long as the copy takes, and every ending is an answer; rejects only when it never ran.
export const osDriveImport = (device: string, sandbox: string, path?: string): Promise<OsDriveImportEnd> =>
    invoke(`os_drive_import`, { device, sandbox, path: path ?? null });
export const osDriveEject = (device: string): Promise<void> => invoke(`os_drive_eject`, { device });
export const onOsDrives = (handler: (seen: OsDrivesSeen) => void): Promise<UnlistenFn> =>
    listen<OsDrivesSeen>(`desktop://os-drives`, (event) => handler(event.payload));
export const onOsDriveImport = (handler: (event: OsDriveImportEvent) => void): Promise<UnlistenFn> =>
    listen<OsDriveImportEvent>(`desktop://os-drive-import`, (event) => handler(event.payload));
