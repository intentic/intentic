import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/* Typed surface of the Rust commands (src-tauri/src/commands.rs) — the launcher's whole backend, and short
 * on purpose: the native side runs the shipped connect/recreate/cleanup scripts and reports what they print,
 * so there is no environment report, no engine, no reconcile plan and no claim result to model here. */

export interface SetupArgs {
    code: string;
    name?: string;
    cfToken?: string;
    syncDir?: string;
    platformUrl?: string;
}

export interface RecreateArgs {
    slug: string;
    hash?: string;
}

export interface SandboxStatus {
    slug: string;
    container: string;
    name: string | null;
    running: boolean;
    image: string;
    tunnelRunning: boolean | null;
}

export interface DesktopInfo {
    version: string;
    os: string;
    appUrl: string;
    platformUrl: string;
    dockerReady: boolean;
}

export interface Settings {
    appUrl: string | null;
    platformUrl: string | null;
}

/* What a running script says, as it says it. `run` is the operation's own id (`setup`, `recreate:<slug>`,
 * `remove:<slug>`) so one window can show several at once, and `stream` is kept because the scripts write
 * progress to stdout and diagnostics to stderr — the failure detail is always in the second one. */
export type RunEvent =
    { kind: `line`; run: string; stream: `stdout` | `stderr`; text: string } | { kind: `exit`; run: string; code: number | null; ok: boolean };

export const desktopInfo = (): Promise<DesktopInfo> => invoke(`desktop_info`);
export const pendingSetup = (): Promise<SetupArgs | null> => invoke(`pending_setup`);
export const takePendingRecreate = (): Promise<RecreateArgs | null> => invoke(`take_pending_recreate`);
export const signIn = (): Promise<void> => invoke(`sign_in`);
export const setupRun = (args: SetupArgs): Promise<void> => invoke(`setup_run`, { args });
export const sandboxList = (): Promise<SandboxStatus[]> => invoke(`sandbox_list`);
export const sandboxPower = (slug: string, start: boolean): Promise<void> => invoke(`sandbox_power`, { slug, start });
// One command for both recreate modes, exactly as the script takes them: no hash updates to the fresh
// :stable base, a hash builds the owner-approved environment overlay pinned to that digest.
export const sandboxRecreate = (slug: string, hash?: string): Promise<void> => invoke(`sandbox_recreate`, { slug, hash });
export const sandboxRemove = (slug: string): Promise<void> => invoke(`sandbox_remove`, { slug });
export const sandboxLogs = (slug: string, tail: number): Promise<string> => invoke(`sandbox_logs`, { slug, tail });
export const workspaceOpen = (): Promise<void> => invoke(`workspace_open`);
export const settingsGet = (): Promise<Settings> => invoke(`settings_get`);
export const settingsSet = (settings: Settings): Promise<void> => invoke(`settings_set`, { settings });

export const onRun = (handler: (event: RunEvent) => void): Promise<UnlistenFn> =>
    listen<RunEvent>(`desktop://run`, (event) => handler(event.payload));
export const onPendingSetup = (handler: () => void): Promise<UnlistenFn> => listen(`desktop://pending-setup`, () => handler());
export const onPendingRecreate = (handler: () => void): Promise<UnlistenFn> => listen(`desktop://pending-recreate`, () => handler());
export const onUpdateAvailable = (handler: (version: string) => void): Promise<UnlistenFn> =>
    listen<string>(`desktop://update-available`, (event) => handler(event.payload));

/* The scripts already narrate themselves — every step they take is an `intentic: …` line, and connect.sh's
 * output IS the progress model the terminal path has always shown. So the launcher does not invent a second
 * one: it promotes those lines to headings and keeps the rest as the detail log behind them. Anything else
 * (docker's own pull output, a build's layer chatter) is noise the user asked to see, not a step. */
const STEP_PREFIX = `intentic: `;

export const isStep = (line: string): boolean => line.startsWith(STEP_PREFIX);
export const stepLabel = (line: string): string => line.slice(STEP_PREFIX.length).trim();
