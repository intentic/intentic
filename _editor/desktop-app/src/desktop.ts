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
    // The third mode of the one recreate script: back to the image this sandbox ran before its last update.
    rollback: boolean;
}

export interface SandboxStatus {
    slug: string;
    container: string;
    name: string | null;
    running: boolean;
    image: string;
    tunnelRunning: boolean | null;
}

/* The three docker verbs this window offers. Named rather than a boolean because the row offers three — the
 * same three the web's Computers tab offers, which is the point of them being one list. */
export type PowerAction = `start` | `stop` | `restart`;

export interface DesktopInfo {
    version: string;
    os: string;
    appUrl: string;
    platformUrl: string;
    dockerReady: boolean;
    /// This installation's own id, minted once and kept in the app's config dir. It is what this screen's
    /// analytics report under, and the same value the workspace window is marked with — the only thread
    /// between what the app did to the machine and what the user then did in the SPA (analytics.ts).
    installId: string;
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
export const setupRun = (args: SetupArgs): Promise<void> => invoke(`setup_run`, { args });
export const sandboxList = (): Promise<SandboxStatus[]> => invoke(`sandbox_list`);
export const sandboxPower = (slug: string, action: PowerAction): Promise<void> => invoke(`sandbox_power`, { slug, action });
// One command for all three recreate modes, exactly as the script takes them: no hash updates to the fresh
// :stable base, a hash builds the owner-approved environment overlay pinned to that digest, and `rollback`
// returns it to the image before the last update.
export const sandboxRecreate = (slug: string, hash?: string, rollback = false): Promise<void> => invoke(`sandbox_recreate`, { slug, hash, rollback });
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
