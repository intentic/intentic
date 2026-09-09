import type { DeviceFolderRow, DevicePortRow, DeviceAgentState } from "@intentic/ui";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// Typed surface over the Rust commands in src-tauri/src/commands.rs. The native side just runs the shipped scripts
// and reports their output, so there's no environment report, engine, reconcile plan, or claim result modeled here.

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
    // Third mode of the recreate script: reverts to the image this sandbox ran before its last update.
    rollback: boolean;
}

// Desktop-sync enrollment via intentic://sync: same URL and single-use token as the copy-paste one-liner, minus
// the folder (picked here). `mirror` is ports-only: nothing synced.
export interface SyncArgs {
    url: string;
    pair: string;
    // Sandbox's display name, shown so the screen names what the folder connects to.
    name?: string;
    takeover: boolean;
    mirror: boolean;
}

// One sandbox's resource share as docker enforces it (commands.rs SandboxResources): caps, privilege, GPU. Matches
// DeviceSandboxResources exactly, so this app's list and the machine agent's report describe one container alike.
export interface SandboxResources {
    memoryBytes?: number;
    cpus?: number;
    privileged: boolean;
    gpu: boolean;
    hostRuntime: string[];
    overlayRuntime: string[];
}

export interface SandboxStatus {
    slug: string;
    container: string;
    name: string | null;
    running: boolean;
    image: string;
    tunnelRunning: boolean | null;
    // Null when the inspect behind it failed; the row just has nothing to say about its share.
    resources: SandboxResources | null;
}

// Docker engine's size (commands.rs DockerEngine): the ceiling the Resources form draws rails against. Null means
// no ceiling, not a wrong one. Read separately since `docker info` is slow.
export interface DockerEngine {
    memoryBytes: number;
    cpus: number;
}

// Only what the Resources form changed; `null` on a cap means back to the default. Mirrors the sandbox contract's
// SandboxResourcesAsk, which the Rust side spells into ic's flags.
export interface ReshapeAsk {
    memoryGib?: number | null;
    cpus?: number | null;
    privileged?: boolean;
    gpu?: boolean;
}

// The three docker verbs this window offers, matching the web's Devices tab so both list the same three.
export type PowerAction = `start` | `stop` | `restart`;

// What the app is, not the machine; every field is already held in-process, so this is one cheap IPC round trip.
// Whether Docker answers is `dockerReady`, asked separately.
export interface DesktopInfo {
    version: string;
    os: string;
    appUrl: string;
    platformUrl: string;
    // Installation id, minted once; the thread analytics.ts uses to tie this app to the user's SPA session.
    installId: string;
}

// What the workspace window's × does: `tray` hides it and leaves the app running; `quit` ends it, same as the tray
// menu's Quit.
export type CloseAction = `tray` | `quit`;

// Sync half of `intentic-machine status --json`. Row types come from @intentic/ui, the same shape the renderer
// needs. `sandboxes` is deliberately absent; use sandboxList for that.
export interface DeviceReport {
    hostname: string;
    os: string;
    pairings: DeviceFolderRow[];
    ports: DevicePortRow[];
    // installed is the file on disk; build is what's actually running — they drift when the binary is replaced live.
    agent: DeviceAgentState & { build?: string; installed?: string };
    // When the agent took the reading; always moments old since this app asks on demand.
    capturedAt: number;
}

// Everything the machine agent knows: sandboxes that may work on this device (links only, never tokens) and the
// sync report. `summary` is the agent's own one-liner, also used by the tray row.
export interface DeviceStatus {
    version: string;
    running?: number;
    summary: string;
    device: { links: { sandboxUrl: string; id: string }[] };
    sync: DeviceReport;
}

// `run` is the operation's own id (setup, recreate:<slug>, ...), so several can run at once; `stream` splits stdout
// progress from stderr failures. `started` carries the transcript path before the first line arrives.
export type RunEvent =
    | { kind: `started`; run: string; log: string | null }
    | { kind: `line`; run: string; stream: `stdout` | `stderr`; text: string }
    | { kind: `exit`; run: string; code: number | null; ok: boolean };

// Two install outcomes exit non-zero by design (needs consent, needs restart); codes are ic's (prepare/mod.rs).
export const EXIT_NEEDS_CONSENT = 3;
export const EXIT_NEEDS_RESTART = 4;

/** Whether an exit code is one of the two designed stops rather than something going wrong. */
export const expectedStop = (code: number | null): boolean => code === EXIT_NEEDS_CONSENT || code === EXIT_NEEDS_RESTART;

// Distinguishes four states: something happening (checking/downloading), nothing to do (current), ready to install
// (one restart away), and `manual` — the only one needing the user, for installs with no release artifact or a
// broken signature check.
export type UpdateStage =
    | { kind: `idle` }
    | { kind: `checking` }
    | { kind: `current` }
    | { kind: `downloading`; version: string; percent: number }
    | { kind: `ready`; version: string }
    | { kind: `manual`; version: string | null; reason: string; url: string };

export const desktopInfo = (): Promise<DesktopInfo> => invoke(`desktop_info`);
// Whether a Docker daemon answers right now; false covers both not-installed and not-started, which the scripts
// tell apart on their own. `docker info` on a stopped daemon can take tens of seconds, so this is its own call.
export const dockerReady = (): Promise<boolean> => invoke(`docker_ready`);
// Taken, not read: two callers race for a parked setup (the arrival event, and this window's read on mount), and
// only one may have it.
export const takePendingSetup = (): Promise<SetupArgs | null> => invoke(`take_pending_setup`);
export const takePendingRecreate = (): Promise<RecreateArgs | null> => invoke(`take_pending_recreate`);
// Taken, not read: the pairing token inside is single-use, so a duplicate delivery would spend it unwatched.
export const takePendingSync = (): Promise<SyncArgs | null> => invoke(`take_pending_sync`);
/**
 * Runs the enrollment (sync.sh/sync.ps1) with the folder the user picked, absent for a mirror pairing. Streams
 * under the `sync-setup` run id.
 */
export const syncRun = (args: SyncArgs, dir?: string): Promise<void> => invoke(`sync_run`, { args, dir: dir ?? null });
/** How much already lives in the folder the user picked, for the sync confirmation message. */
export const folderEntries = (path: string): Promise<number> => invoke(`folder_entries`, { path });
// `install` is the user's answer to the requirements list. The first attempt always passes false (`ic docker
// prepare` only reports what would change); the click to fix it comes back as true.
export const setupRun = (args: SetupArgs, install = false): Promise<void> => invoke(`setup_run`, { args, install });
export const sandboxList = (): Promise<SandboxStatus[]> => invoke(`sandbox_list`);
export const sandboxPower = (slug: string, action: PowerAction): Promise<void> => invoke(`sandbox_power`, { slug, action });
// One command for all three recreate modes: no hash rebuilds :stable, a hash pins the overlay to that digest,
// rollback reverts to the pre-update image.
export const sandboxRecreate = (slug: string, hash?: string, rollback = false): Promise<void> => invoke(`sandbox_recreate`, { slug, hash, rollback });
// Same recreate shim with --reshape/-Reshape: same image, different resource share. Streams under
// `recreate:<slug>`.
export const sandboxReshape = (slug: string, ask: ReshapeAsk): Promise<void> => invoke(`sandbox_reshape`, { slug, ask });
export const dockerEngine = (): Promise<DockerEngine | null> => invoke(`docker_engine`);
export const sandboxRemove = (slug: string): Promise<void> => invoke(`sandbox_remove`, { slug });
export const sandboxLogs = (slug: string, tail: number): Promise<string> => invoke(`sandbox_logs`, { slug, tail });
// Undefined when this device has no agent (an ordinary state, not a failure). Rust returns raw JSON since it has
// no schema for it; parsing happens here.
export const deviceStatus = async (): Promise<DeviceStatus | undefined> => {
    const raw = await invoke<string | null>(`machine_report`);
    return raw === null ? undefined : (JSON.parse(raw) as DeviceStatus);
};
// Stop and start this device's agent loop — the two commands this window used to print for someone to type on the
// computer it is running on. Resolves with whatever the agent itself said.
export const deviceAgentRestart = (): Promise<string> => invoke(`machine_restart`);
// Hands the window back to the workspace, at its root or a path under it — how this window reaches the SPA's
// Devices tab for the same machine.
export const workspaceOpen = (path?: string): Promise<void> => invoke(`workspace_open`, { path: path ?? null });
// Brings this window to the front, for a run that stopped while nobody was looking (windows.rs takes the frame
// back rather than opening beside it).
export const setupAlert = (): Promise<void> => invoke(`setup_alert`);
/* Where the install has got to, as this screen draws it, for the workspace page to draw the same bar once
 * this screen has stepped aside (windows.rs `announce_setup`). Sent on every change: the page's copy of the
 * bar is only ever as fresh as the last report. `closed` is the card being put away after a run ended, which
 * is the page's cue to take its strip down too. */
export interface SetupReport {
    name?: string;
    state: `running` | `waiting` | `failed` | `stopped` | `done` | `closed`;
    percent: number;
    position?: string;
    remaining?: string;
    step?: string;
}
export const setupProgress = (report: SetupReport): Promise<void> => invoke(`setup_progress`, { report });
/* This page's content is `height` tall: size the window to it (fitWindow.ts is the caller). The window is the
 * page's own, chosen on the Rust side from which webview invoked this, so nothing here names one. */
export const fitToContent = (height: number): Promise<void> => invoke(`fit_to_content`, { height });
/** End a run and everything it started. */
export const runStop = (id: string): Promise<void> => invoke(`run_stop`, { id });
/** Show a run's transcript in the machine's own file manager, selected. */
export const revealLog = (path: string): Promise<void> => invoke(`reveal_log`, { path });
// `remember` makes this answer the × from now on and retires the dialog; otherwise it applies once.
export const closeWorkspace = (action: CloseAction, remember: boolean): Promise<void> => invoke(`close_workspace`, { action, remember });

export const onRun = (handler: (event: RunEvent) => void): Promise<UnlistenFn> =>
    listen<RunEvent>(`desktop://run`, (event) => handler(event.payload));
export const onPendingSetup = (handler: () => void): Promise<UnlistenFn> => listen(`desktop://pending-setup`, () => handler());
export const onPendingRecreate = (handler: () => void): Promise<UnlistenFn> => listen(`desktop://pending-recreate`, () => handler());
export const onPendingSync = (handler: () => void): Promise<UnlistenFn> => listen(`desktop://pending-sync`, () => handler());

// Read once, then followed by the event listener below: the read covers a window opening mid-update (the ordinary
// case, since this face is built on demand); without it the screen would sit stale until the next transition.
export const updateState = (): Promise<UpdateStage> => invoke(`update_state`);
export const onUpdate = (handler: (stage: UpdateStage) => void): Promise<UnlistenFn> =>
    listen<UpdateStage>(`desktop://update`, (event) => handler(event.payload));
// Installing ends this process and relaunches on the new version, so nothing after this call resolves; a refusal
// comes back as a message for the screen.
export const updateInstall = (): Promise<void> => invoke(`update_install`);

// Format: `intentic: [<phase>] <sentence>`; unphased output is detail under the running step, not a step itself.
const STEP = /^intentic: \[([a-z-]+)\] (.*)$/;

export interface Step {
    /** The phase id, the same vocabulary the platform's setup report uses. */
    readonly phase: string;
    /** What the script said it was doing, for the reader watching one step. */
    readonly message: string;
}

export const parseStep = (line: string): Step | undefined => {
    const found = STEP.exec(line);
    return found === null ? undefined : { phase: found[1] ?? ``, message: (found[2] ?? ``).trim() };
};

// One line per unmet requirement, emitted only when piped; `action` drives the UI, separate from phase lines.
const REQUIREMENT = /^intentic-requirement: (\{.*\})$/;

/** How an unmet requirement gets met. Mirrors ic's `prepare::plan::Action`, same strings, same meanings. */
export type RequirementAction =
    | `fix` // we can do it, right now
    | `fixElevated` // we can do it, once Windows has asked for administrator
    | `restart` // Windows has to restart first
    | `firmware` // a BIOS/UEFI setting; no software can change it
    | `hostVm` // this Windows is a guest and its host has to change
    | `user` // a person has to do something we cannot
    | `signOut` // done, but only the next sign-in picks it up
    | `unsupported`; // not something this build runs on

export interface Requirement {
    /** Stable id (`virtualization`, `wsl-features`, `docker-desktop`, …), never reworded. */
    readonly id: string;
    /** The heading, in the reader's terms. */
    readonly title: string;
    readonly problem: string;
    readonly remedy: string;
    readonly action: RequirementAction;
    /** The long form, where there is one, the firmware walkthrough, mostly. Pre-formatted; show verbatim. */
    readonly detail?: string;
}

// Live progress for an already-reported requirement; `detail` is the changing measurement underneath.
const REQUIREMENT_STATE = /^intentic-requirement-state: (\{.*\})$/;

export type RequirementState = `running` | `done` | `failed`;

export interface RequirementProgress {
    readonly id: string;
    readonly state: RequirementState;
    readonly detail?: string;
}

const STATES = new Set<string>([`running`, `done`, `failed`]);

export const parseRequirementState = (line: string): RequirementProgress | undefined => {
    const found = REQUIREMENT_STATE.exec(line);
    if (found === null) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(found[1] ?? ``) as Partial<RequirementProgress>;
        if (typeof parsed.id !== `string` || parsed.id === `` || !STATES.has(parsed.state ?? ``)) {
            return undefined;
        }
        return {
            id: parsed.id,
            state: parsed.state as RequirementState,
            ...(parsed.detail ? { detail: parsed.detail } : {}),
        };
    } catch {
        return undefined;
    }
};

export const parseRequirement = (line: string): Requirement | undefined => {
    const found = REQUIREMENT.exec(line);
    if (found === null) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(found[1] ?? ``) as Partial<Requirement>;
        // A requirement with no id can't be keyed, de-duplicated or acted on; leave it to the log.
        return typeof parsed.id === `string` && parsed.id !== ``
            ? {
                  id: parsed.id,
                  title: parsed.title ?? parsed.id,
                  problem: parsed.problem ?? ``,
                  remedy: parsed.remedy ?? ``,
                  action: parsed.action ?? `user`,
                  ...(parsed.detail ? { detail: parsed.detail } : {}),
              }
            : undefined;
    } catch {
        // A truncated line (pipe closed mid-write) is not worth a broken screen.
        return undefined;
    }
};

// Answers once whether a line is a marker for this window rather than transcript text, so a recognised line never
// reaches the log pane and the caller doesn't parse twice.
export type RunMarker =
    { readonly kind: `requirement`; readonly requirement: Requirement } | { readonly kind: `state`; readonly state: RequirementProgress };

export const readMarker = (line: string): RunMarker | undefined => {
    const requirement = parseRequirement(line);
    if (requirement !== undefined) {
        return { kind: `requirement`, requirement };
    }
    const state = parseRequirementState(line);
    return state === undefined ? undefined : { kind: `state`, state };
};

/* --- the native side of a Windows restart, and of coming back from one --- */

/** Save this setup so the app can pick it up after Windows restarts, then restart Windows. */
export const restartForSetup = (args: SetupArgs): Promise<void> => invoke(`restart_for_setup`, { args });
// Like restartForSetup, for the docker-users requirement: it only takes effect at the next sign-in, so this — not
// Check again — is the button that works.
export const signOutForSetup = (args: SetupArgs): Promise<void> => invoke(`sign_out_for_setup`, { args });
/** The setup that was interrupted by a restart, if there is one and it is still worth resuming. */
export const resumableSetup = (): Promise<ResumableSetup | null> => invoke(`resumable_setup`);
/** Forget it, taken when the user backs out, or when its code has expired. */
export const forgetResumableSetup = (): Promise<void> => invoke(`forget_resumable_setup`);

export interface ResumableSetup {
    readonly args: SetupArgs;
    /** Seconds since it was saved. Setup codes last 30 minutes, and a restart can eat most of that. */
    readonly agedSeconds: number;
}
