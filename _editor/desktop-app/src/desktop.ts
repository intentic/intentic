import type { MachineFolderRow, MachinePortRow, MachineWatcherState } from "@intentic/ui";
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

/* What the workspace window's × does. `tray` steps the window aside and leaves the app up; `quit` ends it, the
 * same exit the tray menu's Quit takes. Backing out of the question is not one of these — it is the dialog
 * closing its own window, which changes nothing. */
export type CloseAction = `tray` | `quit`;

/* What desktop sync is doing on this computer, as `intentic-sync status --json` reports it.
 *
 * The row types come from `@intentic/ui`, because the component that renders them is the reason this app reads
 * any of it — there is no second shape to keep in step. `sandboxes` is deliberately absent: the agent never
 * reports containers (it has no business enumerating a machine's other sandboxes), and this app has `sandboxList`
 * for that anyway. */
export interface MachineReport {
    hostname: string;
    os: string;
    agents: { sync?: string };
    pairings: MachineFolderRow[];
    ports: MachinePortRow[];
    watcher: MachineWatcherState;
    // When the agent took the reading. This app asks on demand, so it is always moments old — carried because the
    // shape is the contract's, and a reader that ignores it is not a reader that may drop it.
    capturedAt: number;
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
/* The sync agent's report, or undefined when this computer has no agent — an ordinary state (a machine set up
 * before desktop sync existed), which the screen states rather than treats as a failure. Rust hands back the raw
 * JSON because that process has no schema for it; parsing belongs on the side that does. */
export const machineReport = async (): Promise<MachineReport | undefined> => {
    const raw = await invoke<string | null>(`machine_report`);
    return raw === null ? undefined : (JSON.parse(raw) as MachineReport);
};
export const workspaceOpen = (): Promise<void> => invoke(`workspace_open`);
// `remember` is the dialog's "always do this": it makes this answer the × from now on, and takes the question
// away for good. Without it the answer applies to this close only.
export const closeWorkspace = (action: CloseAction, remember: boolean): Promise<void> => invoke(`close_workspace`, { action, remember });
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
