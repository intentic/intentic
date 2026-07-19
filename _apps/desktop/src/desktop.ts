import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/* Typed surface of the Rust commands (src-tauri/src/commands.rs) — the launcher's whole backend.
 * Shapes mirror intentic-desktop-core's serde types (camelCase). */

export type CheckId = `docker-installed` | `docker-running` | `docker-permission` | `docker-desktop` | `wsl` | `machine-distro` | `machine-docker`;

export interface EnvironmentCheck {
    id: CheckId;
    title: string;
    state: `ok` | `fixable` | `manual`;
    detail: string;
}

export interface EnvironmentReport {
    os: string;
    checks: EnvironmentCheck[];
    engine: { kind: `host-docker`; viaSg: boolean } | { kind: `wsl`; distro: string } | null;
    ready: boolean;
}

export type FixOutcome = { result: `fixed` } | { result: `reboot-required` } | { result: `manual`; instructions: string };

export type SetupMode = `intentic` | `own` | `local`;

export interface SetupArgs {
    code: string;
    mode: SetupMode;
    name?: string;
    cfToken?: string;
    syncDir?: string;
    platformUrl?: string;
}

export interface SandboxRecord {
    slug: string;
    name: string | null;
    mode: SetupMode;
    url: string;
    container: string;
}

export interface SandboxStatus {
    slug: string;
    container: string;
    running: boolean;
    image: string;
    url: string | null;
    name: string | null;
    tunnelRunning: boolean | null;
}

export interface DesktopInfo {
    version: string;
    os: string;
    appUrl: string;
    platformUrl: string;
}

export interface Settings {
    appUrl: string | null;
    platformUrl: string | null;
    rootfsUrl: string | null;
}

export interface ProgressEvent {
    stage: string;
    label: string;
    state: `started` | `log` | `percent` | `done` | `failed`;
    message: string | null;
    percent: number | null;
}

export const desktopInfo = (): Promise<DesktopInfo> => invoke(`desktop_info`);
export const pendingSetup = (): Promise<SetupArgs | null> => invoke(`pending_setup`);
export const environmentProbe = (): Promise<EnvironmentReport> => invoke(`environment_probe`);
export const environmentFix = (check: CheckId): Promise<FixOutcome> => invoke(`environment_fix`, { check });
export const setupRun = (args: SetupArgs): Promise<SandboxRecord> => invoke(`setup_run`, { args });
export const sandboxList = (): Promise<SandboxStatus[]> => invoke(`sandbox_list`);
export const sandboxStart = (slug: string): Promise<void> => invoke(`sandbox_start`, { slug });
export const sandboxStop = (slug: string): Promise<void> => invoke(`sandbox_stop`, { slug });
export const sandboxUpdate = (slug: string): Promise<void> => invoke(`sandbox_update`, { slug });
export const sandboxRemove = (slug: string): Promise<void> => invoke(`sandbox_remove`, { slug });
export const sandboxLogs = (slug: string, tail: number): Promise<string> => invoke(`sandbox_logs`, { slug, tail });
export const workspaceOpen = (): Promise<void> => invoke(`workspace_open`);
export const settingsGet = (): Promise<Settings> => invoke(`settings_get`);
export const settingsSet = (settings: Settings): Promise<void> => invoke(`settings_set`, { settings });

export const onProgress = (handler: (event: ProgressEvent) => void): Promise<UnlistenFn> =>
    listen<ProgressEvent>(`desktop://progress`, (event) => handler(event.payload));
export const onPendingSetup = (handler: () => void): Promise<UnlistenFn> => listen(`desktop://pending-setup`, () => handler());
export const onUpdateAvailable = (handler: (version: string) => void): Promise<UnlistenFn> =>
    listen<string>(`desktop://update-available`, (event) => handler(event.payload));
