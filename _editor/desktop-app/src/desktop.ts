import type { MachineFolderRow, MachinePortRow, MachineWatcherState } from "@intentic/ui";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/* Typed surface of the Rust commands (src-tauri/src/commands.rs), the launcher's whole backend, and short
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

/* The three docker verbs this window offers. Named rather than a boolean because the row offers three, the
 * same three the web's Computers tab offers, which is the point of them being one list. */
export type PowerAction = `start` | `stop` | `restart`;

export interface DesktopInfo {
    version: string;
    os: string;
    appUrl: string;
    platformUrl: string;
    dockerReady: boolean;
    /// This installation's own id, minted once and kept in the app's config dir. It is what this screen's
    /// analytics report under, and the same value the workspace window is marked with, the only thread
    /// between what the app did to the machine and what the user then did in the SPA (analytics.ts).
    installId: string;
}

/* What the workspace window's × does. `tray` steps the window aside and leaves the app up; `quit` ends it, the
 * same exit the tray menu's Quit takes. Backing out of the question is not one of these, it is the dialog
 * closing its own window, which changes nothing. */
export type CloseAction = `tray` | `quit`;

/* What desktop sync is doing on this computer, as `intentic-sync status --json` reports it.
 *
 * The row types come from `@intentic/ui`, because the component that renders them is the reason this app reads
 * any of it, there is no second shape to keep in step. `sandboxes` is deliberately absent: the agent never
 * reports containers (it has no business enumerating a machine's other sandboxes), and this app has `sandboxList`
 * for that anyway. */
export interface MachineReport {
    hostname: string;
    os: string;
    agents: { sync?: string };
    pairings: MachineFolderRow[];
    ports: MachinePortRow[];
    watcher: MachineWatcherState;
    // When the agent took the reading. This app asks on demand, so it is always moments old, carried because the
    // shape is the contract's, and a reader that ignores it is not a reader that may drop it.
    capturedAt: number;
}

/* What a running script says, as it says it. `run` is the operation's own id (`setup`, `recreate:<slug>`,
 * `remove:<slug>`) so one window can show several at once, and `stream` is kept because the scripts write
 * progress to stdout and diagnostics to stderr, the failure detail is always in the second one. */
export type RunEvent =
    { kind: `line`; run: string; stream: `stdout` | `stderr`; text: string } | { kind: `exit`; run: string; code: number | null; ok: boolean };

export const desktopInfo = (): Promise<DesktopInfo> => invoke(`desktop_info`);
export const pendingSetup = (): Promise<SetupArgs | null> => invoke(`pending_setup`);
export const takePendingRecreate = (): Promise<RecreateArgs | null> => invoke(`take_pending_recreate`);
/* `install` is the user's answer to the requirements list, and it is what makes the flow's one question one
 * question. A setup's FIRST attempt always passes false: `ic docker prepare` then examines the machine,
 * reports what would have to change and stops without changing it. The window draws that as a list with a
 * button, and the click comes back here as true. On a machine that needs nothing the two are the same run. */
export const setupRun = (args: SetupArgs, install = false): Promise<void> => invoke(`setup_run`, { args, install });
export const sandboxList = (): Promise<SandboxStatus[]> => invoke(`sandbox_list`);
export const sandboxPower = (slug: string, action: PowerAction): Promise<void> => invoke(`sandbox_power`, { slug, action });
// One command for all three recreate modes, exactly as the script takes them: no hash updates to the fresh
// :stable base, a hash builds the owner-approved environment overlay pinned to that digest, and `rollback`
// returns it to the image before the last update.
export const sandboxRecreate = (slug: string, hash?: string, rollback = false): Promise<void> => invoke(`sandbox_recreate`, { slug, hash, rollback });
export const sandboxRemove = (slug: string): Promise<void> => invoke(`sandbox_remove`, { slug });
export const sandboxLogs = (slug: string, tail: number): Promise<string> => invoke(`sandbox_logs`, { slug, tail });
/* The sync agent's report, or undefined when this computer has no agent, an ordinary state (a machine set up
 * before desktop sync existed), which the screen states rather than treats as a failure. Rust hands back the raw
 * JSON because that process has no schema for it; parsing belongs on the side that does. */
export const machineReport = async (): Promise<MachineReport | undefined> => {
    const raw = await invoke<string | null>(`machine_report`);
    return raw === null ? undefined : (JSON.parse(raw) as MachineReport);
};
/* Hand the window back to the workspace, at the app's root or at a path under it. The path is how this window
 * reaches the SPA's Computers tab, the same machine's containers through the other door, so the two screens
 * that manage them are one click apart instead of each pretending to be the only one. */
export const workspaceOpen = (path?: string): Promise<void> => invoke(`workspace_open`, { path: path ?? null });
/* Which face this window is wearing. The setup screen is a small window of its own, centred on the workspace
 * and movable like any other; the manager fills the frame the workspace was in. windows.rs does the moving,
 * this says which is up. */
export const setupFrame = (setup: boolean): Promise<void> => invoke(`setup_frame`, { setup });
// `remember` is the dialog's "always do this": it makes this answer the × from now on, and takes the question
// away for good. Without it the answer applies to this close only.
export const closeWorkspace = (action: CloseAction, remember: boolean): Promise<void> => invoke(`close_workspace`, { action, remember });

export const onRun = (handler: (event: RunEvent) => void): Promise<UnlistenFn> =>
    listen<RunEvent>(`desktop://run`, (event) => handler(event.payload));
export const onPendingSetup = (handler: () => void): Promise<UnlistenFn> => listen(`desktop://pending-setup`, () => handler());
export const onPendingRecreate = (handler: () => void): Promise<UnlistenFn> => listen(`desktop://pending-recreate`, () => handler());
export const onUpdateAvailable = (handler: (version: string) => void): Promise<UnlistenFn> =>
    listen<string>(`desktop://update-available`, (event) => handler(event.payload));

/* THE SCRIPTS NARRATE THEMSELVES, AND NAME WHAT THEY ARE NARRATING. Every phase of an install is announced
 * as `intentic: [<phase>] <sentence>`, connect.sh's step(), connect.ps1's Write-Step, ic's util::step, one
 * contract in three languages, so this window never has to recognise a sentence to know where a run is.
 * That is the whole point of the id being there: the prose is reworded whenever it reads better, and a
 * progress bar that moves when somebody fixes a typo is worse than no progress bar.
 *
 * Everything printed WITHOUT a phase (docker's layer chatter, a build's output, ic's closing prose) is
 * detail under whichever step is running, shown in the log behind "Show detail", never a step of its own. */
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

/* SOMETHING THIS COMPUTER NEEDS BEFORE A SANDBOX CAN RUN, the other thing the installer prints, and the
 * only one this window turns into a control rather than a line of text.
 *
 * Windows is the reason this exists. On Linux and macOS "you need Docker" is one sentence with one fix; on
 * Windows it is a tree, virtualization switched off in firmware, WSL2 absent, a restart Windows is already
 * waiting for, a package manager this PC does not have, an engine in the wrong container mode, and the
 * difference between them is the difference between a button that fixes it, a button that restarts, and a
 * page of instructions for something no software can do from inside Windows.
 *
 * So `ic docker prepare` prints one of these per unmet requirement, and `action` is what this window
 * switches on. It is a SEPARATE marker from the phase lines above, deliberately: a requirement is not a step,
 * and a parser that took it for one would slide the progress bar to a phase that does not exist.
 *
 * Emitted only when the installer's output is a pipe, which is exactly this window, and never a terminal,
 * where the same information is already prose. */
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

export const parseRequirement = (line: string): Requirement | undefined => {
    const found = REQUIREMENT.exec(line);
    if (found === null) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(found[1] ?? ``) as Partial<Requirement>;
        // A requirement with no id is one this window cannot key, de-duplicate or act on, which makes it a
        // line of text, and there is already a log for those.
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
        // A truncated line (the pipe closed mid-write) is not worth a broken screen.
        return undefined;
    }
};

/* --- the native side of a Windows restart, and of coming back from one --- */

/** Save this setup so the app can pick it up after Windows restarts, then restart Windows. */
export const restartForSetup = (args: SetupArgs): Promise<void> => invoke(`restart_for_setup`, { args });
/** The setup that was interrupted by a restart, if there is one and it is still worth resuming. */
export const resumableSetup = (): Promise<ResumableSetup | null> => invoke(`resumable_setup`);
/** Forget it, taken when the user backs out, or when its code has expired. */
export const forgetResumableSetup = (): Promise<void> => invoke(`forget_resumable_setup`);

export interface ResumableSetup {
    readonly args: SetupArgs;
    /** Seconds since it was saved. Setup codes last 30 minutes, and a restart can eat most of that. */
    readonly agedSeconds: number;
}
