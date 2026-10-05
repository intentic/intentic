import type { DeviceAgentState, DeviceFolderRow, DevicePortRow, DeviceSandboxResources, ResourcesForm } from "@intentic/ui";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LocalFound } from "@intentic/web/local-host";
import type { FixEnd } from "./fixReport";

// Typed surface over the Rust commands in src-tauri/src/commands.rs. The native side just runs the shipped scripts
// and reports their output, so there's no environment report, engine, reconcile plan, or claim result modeled here.

export interface SetupArgs {
    code: string;
    // The platform row this install is for, so a run that ends here can hand the SAME sandbox back to /setup.
    sandboxId?: string;
    name?: string;
    cfToken?: string;
    syncDir?: string;
    platformUrl?: string;
    // A folder of this computer becoming the sandbox's project: its name inside /work (src-tauri/src/project.rs).
    project?: string;
    // The slug its container is named by, where the app knew it before the run (a setup it made itself).
    slug?: string;
}

export interface RecreateArgs {
    slug: string;
    hash?: string;
    // Third mode of the recreate script: reverts to the image this sandbox ran before its last update.
    rollback: boolean;
}

// The recovery panel's "Fix it" via intentic://fix (src-tauri/src/fix.rs): the sandbox on this machine to run
// `ic sandbox fix` for, and the fix code that mirrors the run on the panel that asked, when it sent one.
export interface FixArgs {
    slug: string;
    // Null, as serde writes an absent one.
    code?: string | null;
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

// One sandbox as `ic sandbox list --json` reports it (the sandbox contract's DeviceSandbox), with the name this app
// remembers for it: the same rows the machine agent hands the web, so this app's list and the Devices view describe
// one container alike. `resources` carries the shape it runs with and the shape saved for its next restart; absent
// when ic could not inspect the container.
export interface SandboxStatus {
    slug: string;
    container: string;
    name?: string;
    running: boolean;
    image: string;
    tunnelRunning?: boolean;
    resources?: DeviceSandboxResources;
}

// Docker engine's size (commands.rs DockerEngine): the ceiling the Resources form draws rails against. Null means
// no ceiling, not a wrong one. Read separately since `docker info` is slow.
export interface DockerEngine {
    memoryBytes: number;
    cpus: number;
}

// The three power verbs this window offers, matching the web's Devices tab so both list the same three. All go
// through `ic`, so a start or restart applies a shape saved for the next restart.
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
    // Seconds a Docker start waits for its engine before it answers `tookTooLong`.
    engineLimitSeconds: number;
    // Seconds an `ic sandbox fix` may run before the app stops it.
    fixLimitSeconds: number;
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

const COMMAND_FAILURE = /^Command failed,\s+(.+)$/;

/** A command's terminal error, only when stderr explicitly says the command failed. */
export const parseCommandFailure = (event: RunEvent): string | undefined => {
    if (event.kind !== `line` || event.stream !== `stderr`) {
        return undefined;
    }
    return COMMAND_FAILURE.exec(event.text)?.[1]?.trim();
};

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

/* THE ENGINE, AND THIS WINDOW'S JOB OF STARTING IT — scripts.rs states why nothing else on the machine will. */

// Is anything listening where the engine listens? Microseconds, unlike `dockerReady` — this is the question a
// screen asks before it can afford to wait, and the one the launch itself is decided on.
export const dockerListening = (): Promise<boolean> => invoke(`docker_listening`);
/** How far starting the engine got. Mirrors commands.rs `DockerStart`, same strings, same meanings. */
export type DockerOutcome = `ready` | `notInstalled` | `wouldNotStart` | `notAllowed` | `tookTooLong`;
export interface DockerStart {
    readonly outcome: DockerOutcome;
    /** Docker's own last words, shown under the card's sentence. Empty when there are none. */
    readonly detail: string;
}
// Minutes long, and every ending is an answer rather than a throw: the card has a sentence for each of them.
export const dockerStart = (): Promise<DockerStart> => invoke(`docker_start`);
/** Docker Desktop's own window, in front — its welcome screen is the one thing this app cannot answer. */
export const dockerOpen = (): Promise<void> => invoke(`docker_open`);
/** Whether a sandbox has ever run on this machine: the licence to start its Docker at all. */
export const hostsSandboxes = (): Promise<boolean> => invoke(`hosts_sandboxes`);
// Taken, not read: only the launch that opened this face BECAUSE the engine was asleep hands over to the
// workspace by itself. A window opened from the tray was asked for, and stays where it was put.
export const takePendingDocker = (): Promise<boolean> => invoke(`take_pending_docker`);
// Taken, not read: two callers race for a parked setup (the arrival event, and this window's read on mount), and
// only one may have it.
export const takePendingSetup = (): Promise<SetupArgs | null> => invoke(`take_pending_setup`);
export const takePendingRecreate = (): Promise<RecreateArgs | null> => invoke(`take_pending_recreate`);
// Taken, not read: a fix request runs once, in whichever mount of this window finds it first.
export const takePendingFix = (): Promise<FixArgs | null> => invoke(`take_pending_fix`);
// `ic sandbox fix <slug> [--code] --source app --json [--accept <id>]`, streamed under the run id `fix`. Rejects only
// when it never ran (no ic here, one already running); how a run that did ended is the answer (fixReport.ts `FixEnd`).
export const sandboxFix = (slug: string, code: string | null | undefined, accept: readonly string[]): Promise<FixEnd> =>
    invoke(`sandbox_fix`, { slug, code: code ?? null, accept });
// Taken, not read: the pairing token inside is single-use, so a duplicate delivery would spend it unwatched.
export const takePendingSync = (): Promise<SyncArgs | null> => invoke(`take_pending_sync`);
/** Runs the enrollment (sync.sh/sync.ps1) with the folder the user picked, absent for a mirror pairing. */
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
// Same recreate shim with --shape/-Shape: `ic sandbox shape`, a whole shape now or for the next restart through ic,
// or (no shape) forgetting the one saved. Streams under `recreate:<slug>`.
export const sandboxResize = (slug: string, form: ResourcesForm | undefined, when: `now` | `nextRestart`): Promise<void> =>
    invoke(`sandbox_shape`, { slug, shape: form ?? null, when });
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
// The workspace in the main window's place, at its root or a path under it: how This device reaches the workspace's
// Devices tab for the same machine, and how a finished setup hands back.
export const workspaceOpen = (path?: string): Promise<void> => invoke(`workspace_open`, { path: path ?? null });
// Brings the main window to the front at This device, for a run that stopped while nobody was looking (windows.rs takes
// the frame back rather than opening beside it).
export const setupAlert = (): Promise<void> => invoke(`setup_alert`);
/* Setup progress is shared with the workspace bar. */
/** What a setup stopped on a question is waiting for: the reader's go-ahead, or a session Windows has to end. */
export type SetupWaitingFor = `consent` | `restart` | `signOut`;
export interface SetupReport {
    name?: string;
    state: `running` | `waiting` | `failed` | `stopped` | `done` | `closed`;
    percent: number;
    position?: string;
    remaining?: string;
    step?: string;
    /** On `waiting`: what the question asks (commands.rs `SetupReport`). */
    waitingFor?: SetupWaitingFor;
    /** On `waiting`: the requirement ids on the card, for the page's analytics. */
    requirements?: string[];
}
export const setupProgress = (report: SetupReport): Promise<void> => invoke(`setup_progress`, { report });
/* This page's content is `height` tall: size the window to it (fitWindow.ts is the caller). */
export const fitToContent = (height: number): Promise<void> => invoke(`fit_to_content`, { height });
/** End a run and everything it started. */
export const runStop = (id: string): Promise<void> => invoke(`run_stop`, { id });
/** Show a run's transcript in the machine's own file manager, selected. */
export const revealLog = (path: string): Promise<void> => invoke(`reveal_log`, { path });
/** The only way out of this face: a `target="_blank"` on a local page opens nothing (commands.rs `open_url`). */
export const openUrl = (url: string): Promise<void> => invoke(`open_url`, { url });

// A folder or a document of this computer (src-tauri/src/local.rs): no sandbox, no sign-in. `recent` is newest first,
// as the app remembers them (state.rs `Recent`), in the shape the shell reads (the web's localHost.ts `LocalPlace`).
export interface LocalRecent {
    path: string;
    folder: boolean;
    // When it was last opened: Unix seconds as state.rs keeps them, or an ISO 8601 instant.
    openedAt: number | string;
    // Whether the path is still there, asked as the list is read: a recent that has moved is drawn as moved.
    exists: boolean;
    // Whether the folder has a sandbox of its own (projects.json, src-tauri/src/project.rs).
    sandbox: boolean;
}
// The system dialog, then what was chosen: a folder shown in the window that asked, in place of its own; a document
// opened where the app puts it. Nothing chosen changes nothing.
export const localPick = (folder: boolean): Promise<void> => invoke(`local_pick`, { folder });
// The folder at `path` shown in the window that asks, in place of the one it shows (local.rs `point`).
export const localPoint = (path: string): Promise<void> => invoke(`local_point`, { path });
// Rejects with a sentence written for the reader ("isn't there any more", "isn't allowed"), shown beside the row.
export const localOpenPath = (path: string): Promise<void> => invoke(`local_open_path`, { path });
export const localRecents = (): Promise<LocalRecent[]> => invoke(`local_recents`);
/** Takes one entry off the recents, wherever it is in them; the folder or file itself is not touched. */
export const localForgetRecent = (path: string): Promise<void> => invoke(`local_forget_recent`, { path });
// What this computer's AI tools say: the subscriptions signed in here, by who they are for, and the folders their
// histories name (src-tauri/src/found.rs), in the shape the shell reads (the web's localHost.ts `LocalFound`).
export const foundOnMachine = (): Promise<LocalFound> => invoke(`found_on_machine`);
// Who is signed in to the workspace and the sandboxes it last listed (src-tauri/src/setup_link.rs `Roster`), in the
// shape the shell reads (the web's localHost.ts `LocalRoster`): empty before the workspace has said, and after a sign-out.
export interface LocalSandbox {
    id: string;
    name: string;
    // Where it runs, as the workspace's switcher marked it (placement.ts `SandboxPlacementKind`).
    place: string;
    shared: boolean;
}
export interface LocalAccount {
    email: string;
    // Absent where the account has none; the avatar only as an https address.
    name?: string;
    image?: string;
}
export interface LocalRoster {
    account: LocalAccount | null;
    sandboxes: LocalSandbox[];
}
export const localRoster = (): Promise<LocalRoster> => invoke(`local_roster`);

// One platform call of a local window's account menu or Settings, sent by the app with the session the workspace signed
// in with (src-tauri/src/account.rs), which checks it against a short list of its own. The answer is the platform's, as
// a fetch would have had it; nobody signed in is the platform's own answer to that (`null`, or 401). Rejects with a
// sentence for the reader when the platform cannot be reached, and when the call is not on the list.
export interface AccountAsk {
    method: `GET` | `POST`;
    // The platform path, with a query on a GET: `/api/auth/get-session`, `/rpc/tokens`.
    path: string;
    // JSON, on a POST.
    body?: string;
}
export interface AccountAnswer {
    status: number;
    body: string;
    contentType: string | null;
}
export const accountRelay = (ask: AccountAsk): Promise<AccountAnswer> => invoke(`account_relay`, { ask });

/* A FOLDER'S OWN SANDBOX, asked for in its window's own dialog (src-tauri/src/project.rs), never naming a folder: the
   app always means the window's own. */

/** Why a folder cannot have a sandbox (project.rs `Refusal`), drawn in the reader's words by its `kind`. */
export type ProjectRefusal =
    | { readonly kind: `disk` | `home` | `holdsHome` | `homes` | `aHome` | `system` }
    | { readonly kind: `inside` | `around`; readonly other: string };

/** What to beware of before a folder becomes a project (project.rs `Caution`). */
export type ProjectCaution = { readonly kind: `synced`; readonly service: string } | { readonly kind: `away` };

/** What the folder's dialog draws (project.rs `Preview`). */
export type ProjectPreview =
    | { readonly kind: `existing` }
    | { readonly kind: `document` }
    | { readonly kind: `refused`; readonly refusal: ProjectRefusal }
    | {
          readonly kind: `new`;
          readonly name: string;
          readonly path: string;
          readonly files: number;
          readonly bytes: number;
          readonly more: boolean;
          readonly large: boolean;
          readonly cautions: readonly ProjectCaution[];
          readonly signedIn: boolean;
          readonly imageReady: boolean;
          readonly busy: boolean;
      };

/** The names the page derived from the folder's, and the row an earlier attempt made (project.rs `CreateAsk`). */
export interface ProjectAsk {
    readonly name: string;
    readonly project: string;
    readonly sandboxId?: string;
}

/** What came of "Create sandbox" (project.rs `Created`). */
export type ProjectCreated = { readonly kind: `setup`; readonly setup: SetupArgs } | { readonly kind: `signIn` } | { readonly kind: `opened` };

export const projectPreview = (): Promise<ProjectPreview> => invoke(`project_preview`);
// Rejects with a sentence for the reader: the platform out of reach, a refusal of its own, a setup already running here.
export const projectCreate = (ask: ProjectAsk): Promise<ProjectCreated> => invoke(`project_create`, { ask });

/* WHAT THE SHELL AND THIS DEVICE ARE DRAWN FROM: facts the app keeps across launches (src-tauri/src/state.rs). */

// Which face the app last showed by the user's own choice: what a launch opens onto. `home` is the main local window,
// the shell on this computer's folder; `workspace` the hosted workspace.
export type LastFace = `home` | `workspace`;

export interface HomeFacts {
    // A sign-in has completed in this install (or the workspace was shown, before that was remembered): the way to
    // agents is the workspace, not a sign-in.
    accountSeen: boolean;
    lastFace: LastFace;
    // A sandbox has been set up on this machine, so its Docker and its agent are This device's business.
    hostsSandboxes: boolean;
    // The folder the main window opens on (`~/intentic/local` until another is shown there).
    homeFolder: string;
}
export const homeFacts = (): Promise<HomeFacts> => invoke(`home_facts`);
// Platform sign-in in the default browser (auth.rs); the account comes back over `intentic://auth`.
export const signIn = (): Promise<void> => invoke(`sign_in`);
// `remember` makes this answer the × from now on and retires the dialog; otherwise it applies once.
export const closeWorkspace = (action: CloseAction, remember: boolean): Promise<void> => invoke(`close_workspace`, { action, remember });

export const onRun = (handler: (event: RunEvent) => void): Promise<UnlistenFn> =>
    listen<RunEvent>(`desktop://run`, (event) => handler(event.payload));
export const onPendingSetup = (handler: () => void): Promise<UnlistenFn> => listen(`desktop://pending-setup`, () => handler());
export const onPendingRecreate = (handler: () => void): Promise<UnlistenFn> => listen(`desktop://pending-recreate`, () => handler());
export const onPendingFix = (handler: () => void): Promise<UnlistenFn> => listen(`desktop://pending-fix`, () => handler());
export const onPendingSync = (handler: () => void): Promise<UnlistenFn> => listen(`desktop://pending-sync`, () => handler());

// Read once, then followed by the event listener below: the read covers a window opening mid-update (the ordinary
// case, since this face is built on demand); without it the screen would sit stale until the next transition.
export const updateState = (): Promise<UpdateStage> => invoke(`update_state`);
export const onUpdate = (handler: (stage: UpdateStage) => void): Promise<UnlistenFn> =>
    listen<UpdateStage>(`desktop://update`, (event) => handler(event.payload));
// Installing ends this process and relaunches on the new version, so nothing after this call resolves; a refusal or
// a failed install comes back as a message for the screen, and a failed one also turns the stage `manual`.
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

/** Which way Windows was asked to end the session for a setup (commands.rs `SessionEnd`). */
export type SessionEnd = `restart` | `signout`;

export interface ResumableSetup {
    readonly args: SetupArgs;
    /** Seconds since it was saved. Setup codes last 30 minutes, and a restart can eat most of that. */
    readonly agedSeconds: number;
    /** How the session ended for it. */
    readonly how: SessionEnd;
}
