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

/* A desktop-sync enrollment the SPA handed over (`intentic://sync`): the same SANDBOX_URL and single-use
 * pairing token the copy-paste one-liner carries, minus the folder — collecting THAT in a system dialog is
 * the whole point of the handoff. `mirror` is a ports-only pairing: nothing to pick, nothing synced. */
export interface SyncArgs {
    url: string;
    pair: string;
    /// The sandbox's display name, so the screen can say what the folder is being connected to.
    name?: string;
    takeover: boolean;
    mirror: boolean;
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

/* What the app is, and nothing about the machine — see the Rust side for why that line is drawn here. Every
 * field is something the process already holds, so this read costs one IPC round trip and is safe to sit in
 * front of everything the window does next. Whether Docker answers is `dockerReady` below, asked apart. */
export interface DesktopInfo {
    version: string;
    os: string;
    appUrl: string;
    platformUrl: string;
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
 * progress to stdout and diagnostics to stderr, the failure detail is always in the second one.
 *
 * `started` carries where the run's transcript is being written. It arrives before the first line, so the
 * screen can offer the log from the moment there is one rather than only after something has gone wrong,
 * which is the moment somebody most wants a file they can send. */
export type RunEvent =
    | { kind: `started`; run: string; log: string | null }
    | { kind: `line`; run: string; stream: `stdout` | `stderr`; text: string }
    | { kind: `exit`; run: string; code: number | null; ok: boolean };

/* WHY `ic docker prepare` STOPPED, when stopping was the plan.
 *
 * Two of this flow's outcomes are not failures: a machine that needs consent before anything is changed
 * (which is EVERY Windows install that needs anything, by design: the first pass reports and stops), and a
 * machine that has to restart. Both used to leave as `exit 1` with a line on stderr, which is how a run that
 * did exactly what it was built to do reaches the screen looking like a crash, and how a screen with no
 * requirements to draw ends up showing "connect.ps1 exited with status 1" and nothing else.
 *
 * The codes are `ic`'s (prepare/mod.rs) and ride out through the shim's own `exit $LASTEXITCODE`. */
export const EXIT_NEEDS_CONSENT = 3;
export const EXIT_NEEDS_RESTART = 4;

/** Whether an exit code is one of the two designed stops rather than something going wrong. */
export const expectedStop = (code: number | null): boolean => code === EXIT_NEEDS_CONSENT || code === EXIT_NEEDS_RESTART;

/* WHAT THE APP IS DOING ABOUT ITS OWN VERSION (src-tauri/src/update.rs).
 *
 * One value rather than "a newer version exists", which is all the old event carried and the reason this
 * screen's only available sentence was a guess about the future: "it installs the next time you quit", while
 * nothing in the app installed anything, ever.
 *
 * The states this screen actually distinguishes are three: something is happening (checking, downloading),
 * nothing needs to happen (current), and something is ON THIS MACHINE and one restart away (ready). `manual`
 * is the fourth and the only one that asks the user for anything: a .deb or .rpm install, which the release
 * manifest has no artifact for, or a copy whose signature check can never pass again. */
export type UpdateStage =
    | { kind: `idle` }
    | { kind: `checking` }
    | { kind: `current` }
    | { kind: `downloading`; version: string; percent: number }
    | { kind: `ready`; version: string }
    | { kind: `manual`; version: string | null; reason: string; url: string };

export const desktopInfo = (): Promise<DesktopInfo> => invoke(`desktop_info`);
/* A Docker daemon answers right now. False covers both "not installed" and "not started" — the scripts tell
 * those apart themselves (winget on Windows, get.docker.com on Linux), so this screen only needs the one bit.
 *
 * SLOW ON EXACTLY THE MACHINE THIS APP IS FOR, which is why it is its own call and why nothing waits on it:
 * `docker info` against an installed-but-stopped daemon spends tens of seconds on the socket. See the Rust
 * side for the frozen window that bought, and App.vue for what it means to draw a screen without the answer. */
export const dockerReady = (): Promise<boolean> => invoke(`docker_ready`);
/* Taken, not read, see the Rust side. Two callers race for a parked setup (the arrival event, and this
 * window's own read on mount) and only one of them may have it: the loser used to receive the same request a
 * second time, or a `null` it then wrote over its own state as "there is no setup here", which took a
 * running install's screen away with it. */
export const takePendingSetup = (): Promise<SetupArgs | null> => invoke(`take_pending_setup`);
export const takePendingRecreate = (): Promise<RecreateArgs | null> => invoke(`take_pending_recreate`);
/* Taken, not read, with the sharpest stake of the three: the pairing token inside is single-use, and a
 * request delivered twice would spend it on a run nobody is watching. */
export const takePendingSync = (): Promise<SyncArgs | null> => invoke(`take_pending_sync`);
/** Run the enrollment — sync.sh / sync.ps1, the same script the card's one-liner runs — with the folder the
 *  user picked (absent for a mirror pairing, which has none). Events stream under the `sync-setup` run id. */
export const syncRun = (args: SyncArgs, dir?: string): Promise<void> => invoke(`sync_run`, { args, dir: dir ?? null });
/** How much already lives in a folder the user just picked — what makes the sync confirmation a sentence
 *  about their files rather than boilerplate. */
export const folderEntries = (path: string): Promise<number> => invoke(`folder_entries`, { path });
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
/* Bring this window back to the front and ask the OS to point at it. For a run that stopped while nobody was
 * looking at it — including one the user walked away from, where the workspace has the frame and this face has
 * to take it back rather than open beside it (windows.rs). */
export const setupAlert = (): Promise<void> => invoke(`setup_alert`);
/** End a run and everything it started. */
export const runStop = (id: string): Promise<void> => invoke(`run_stop`, { id });
/** Show a run's transcript in the machine's own file manager, selected. */
export const revealLog = (path: string): Promise<void> => invoke(`reveal_log`, { path });
// `remember` is the dialog's "always do this": it makes this answer the × from now on, and takes the question
// away for good. Without it the answer applies to this close only.
export const closeWorkspace = (action: CloseAction, remember: boolean): Promise<void> => invoke(`close_workspace`, { action, remember });

export const onRun = (handler: (event: RunEvent) => void): Promise<UnlistenFn> =>
    listen<RunEvent>(`desktop://run`, (event) => handler(event.payload));
export const onPendingSetup = (handler: () => void): Promise<UnlistenFn> => listen(`desktop://pending-setup`, () => handler());
export const onPendingRecreate = (handler: () => void): Promise<UnlistenFn> => listen(`desktop://pending-recreate`, () => handler());
export const onPendingSync = (handler: () => void): Promise<UnlistenFn> => listen(`desktop://pending-sync`, () => handler());

/* THE APP'S OWN VERSION, READ ONCE AND THEN FOLLOWED — and both halves are load-bearing.
 *
 * The event covers everything that changes while this window is open. The read covers the window that OPENS
 * in the middle of it, which is the ordinary case: this face is built on demand, and a download that started
 * at launch has usually finished before anyone opens the manager. With only the listener the screen would sit
 * on whatever it was born with until the next transition — which, on a machine that is up to date, never comes. */
export const updateState = (): Promise<UpdateStage> => invoke(`update_state`);
export const onUpdate = (handler: (stage: UpdateStage) => void): Promise<UnlistenFn> =>
    listen<UpdateStage>(`desktop://update`, (event) => handler(event.payload));
/* Take the offer. Installing ends this process and comes back on the new version, so nothing after this
 * resolves; a refusal (a script run in flight) comes back as words for the screen. */
export const updateInstall = (): Promise<void> => invoke(`update_install`);

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

/* HOW ONE REQUIREMENT IS GOING, RIGHT NOW. The marker that turns the list into a live checklist.
 *
 * `intentic-requirement:` says a thing is unmet and says nothing about the ten minutes that follow. Through
 * those ten minutes this screen could draw exactly one row, "Set up Docker", with a spinner on it, while
 * WSL2 was switched on, 600 MB came down, an installer ran, an engine started and a daemon was waited for.
 * The reader with the least patience in this whole flow is the one on the machine that needs the most work,
 * and they were the one shown the least.
 *
 * `detail` is the changing measurement under the row: the megabytes, the seconds left on the engine wait. */
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

/* IS THIS LINE ADDRESSED TO THE WINDOW RATHER THAN TO THE READER, asked once so the answer can do two jobs.
 *
 * Both markers above are JSON the CLI writes for this app to parse, and both used to be appended to the log
 * pane on their way past — so a reader watching an install saw the rows AND the raw records behind them,
 * unwrapped, running off the right edge. The two calls happened at different points in App.vue's handler, one
 * after the other, which is why the "is it a marker" question could not gate the append.
 *
 * So: one call, one answer, and a line the window recognises never reaches the transcript on screen. The
 * discriminated union is what lets the caller keep the two behaviours apart without parsing twice. */
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
/* The same, one notch smaller, for the requirement that is only ever waiting on a new login token. Adding an
 * account to `docker-users` takes effect at the next sign-in and not before, so "Check again" is a button
 * that cannot work; this is the one that can. */
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
