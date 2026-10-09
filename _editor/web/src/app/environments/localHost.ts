import { type User, UserSchema } from "@intentic/api-contract";
import type { ViewBadge } from "@intentic/extension-api";
import type { Component, Ref } from "vue";
import { z } from "zod";
import { askLocalApp } from "./local";

// THE APP'S HALF OF A LOCAL WINDOW'S SHELL. The editor draws the shell around a folder of this computer (local/LocalShell.vue):
// its rail, its Files view, the place chip and the way to agents. What only the desktop app can answer comes from here:
// the folders and documents this computer has opened, pointing the window at another folder, whether this install has an
// account, who the workspace last said is signed in and which sandboxes it listed, the account itself (asked of the
// platform by the app, with the session the workspace signed in with, which this page never holds), and the views the
// app adds to the rail (This device, titled This computer). The app installs its host on the window before the
// editor's modules run (`__INTENTIC_LOCAL_HOST__`, _editor/desktop-app/src/host.ts), so it is there when the router
// builds its routes. A window without one (a dev server, a test) gets `LINK_HOST`: what any local window can ask by link.

/** A folder or a document of this computer the app remembers opening, newest first (the app's state.rs `RecentView`). */
export interface LocalPlace {
    readonly path: string;
    readonly folder: boolean;
    /** When it was last opened: Unix seconds, epoch ms or an ISO instant, as the app kept it. */
    readonly openedAt: number | string;
    /** Still there when the list was read: one that has moved is drawn as moved, and opens nothing. */
    readonly exists: boolean;
    /** It has a sandbox of its own, kept in sync with it (the app's projects.json). */
    readonly sandbox: boolean;
}

/** What this install knows that the shell draws differently by. */
export interface LocalFacts {
    /** A sign-in has completed here, or the workspace was shown: the way to agents is the workspace, not a sign-in. */
    readonly accountSeen: boolean;
    /** The folder the app opens its main window on when nothing else is asked for (`~/intentic/local` at first). */
    readonly homeFolder: string;
}

/**
 * A subscription some AI tool on this computer is signed in to (the app's found.rs `FoundProvider`): named by who it is
 * for, never by a token. The sandbox signs in to it on its own (Connect), so the tool here keeps its login.
 */
export interface LocalFoundProvider {
    /** The sandbox's id for it (`claude`, `codex`, `gemini`, `grok`, `kimi`), as `PROVIDER_SPECS` names them. */
    readonly provider: string;
    /** The tools it was found signed in through: `claude-code`, `codex`, `gemini-cli`, `opencode`, `hermes`, `openclaw`. */
    readonly tools: readonly string[];
    readonly email: string | null;
    /** The plan as the tool recorded it (`max`, `team`, `plus`…). */
    readonly plan: string | null;
    /** The WSL distro it was found in, when it was found nowhere else. */
    readonly wsl: string | null;
}

/** A folder some AI tool or editor on this computer worked in, from that tool's own history (found.rs `FoundProject`). */
export interface LocalFoundProject {
    /** Where this computer opens it (`\\wsl.localhost\<distro>\…` for a distro's): what `point` takes. */
    readonly path: string;
    /** How the tools spelled it: the Linux path for a distro's, otherwise `path`. */
    readonly shown: string;
    readonly name: string;
    /** The histories that named it: `claude-code`, `codex`, `vscode`, `cursor`, `vscodium`, `windsurf`, `jetbrains`. */
    readonly sources: readonly string[];
    /** Unix seconds of the newest use any of them recorded. */
    readonly lastActive: number | null;
    readonly wsl: string | null;
    readonly git: boolean;
    /** It has a sandbox of its own already (the app's projects.json). */
    readonly sandbox: boolean;
}

/** What this computer's own tools say. Read on this computer and never sent anywhere. */
export interface LocalFound {
    readonly providers: readonly LocalFoundProvider[];
    readonly projects: readonly LocalFoundProject[];
}

export const NOTHING_FOUND: LocalFound = { providers: [], projects: [] };

/** A sandbox of the account, as the workspace's switcher last listed it (the app's setup_link.rs `RosterEntry`). */
export interface LocalSandbox {
    readonly id: string;
    readonly name: string;
    /** Where it runs, as the workspace's switcher marked it: a placement kind, read by placement.ts `placementOfKind`. */
    readonly place: string;
    /** Somebody else's sandbox, shared with this account. */
    readonly shared: boolean;
}

/** Who is signed in to the workspace, as it last told the app (the app's setup_link.rs `RosterAccount`). */
export interface LocalAccount {
    readonly email: string;
    readonly name?: string;
    /** An https address; an uploaded avatar does not ride along. */
    readonly image?: string;
}

/** What the workspace last told the app about its account: who is signed in, and its sandboxes in the switcher's order. */
export interface LocalRoster {
    readonly account: LocalAccount | null;
    readonly sandboxes: readonly LocalSandbox[];
}

/** A view the app adds to the local shell: a rail tile and the route it opens (This device, in the desktop app). */
export interface LocalView {
    /** The route's path under the shell, without its slash (`device`), which is also the route's name. */
    readonly path: string;
    /** The section its tile is drawn and ranked as (`devices`: the kit's glyph for this computer, `sectionIcon`). */
    readonly section: string;
    /** Its name on the rail and in the window, asked for when drawn so it follows the reader's language. */
    readonly title: () => string;
    /** Its screen, fetched the first time it is opened (the router wraps it as every in-shell view is, `asyncView`). */
    readonly load: () => Promise<{ readonly default: Component }>;
    /** What its tile carries (a setup running here, an update waiting), when it carries anything. */
    readonly badge?: Readonly<Ref<ViewBadge | undefined>>;
    /** False for a view that is routed but has no rail tile, opened from where it is needed (Repair). Drawn when absent. */
    readonly inRail?: boolean;
}

/* FIRST RUN (2026-10-09): what a new computer needs before agents can run on it, answered by the app (the read-only
   `ic docker prepare --dry-run`, the download it starts at first launch, the PC's own setup) and drawn on the local
   shell's Agents view. The PC's own setup (WSL, the container engine) needs no account: it runs on the reader's one
   "Set up this PC". The sandbox itself is made once someone is signed in (LocalMachineState). The first task is written
   while the PC is set up, kept on disk by the app so a restart keeps it, and sent once this computer's sandbox is ready. */

/** One line of the check of this PC: already fine, done by Intentic, the reader's to do, or impossible here. */
export interface LocalCheckRow {
    /** The requirement's id as `ic docker prepare` names it (`wsl-features`, `virtualization`, `memory`…). */
    readonly id: string;
    readonly state: `met` | `ours` | `yours` | `blocked`;
    /** The line in the reader's words, as the app wrote it. */
    readonly label: string;
    readonly detail: string | undefined;
    /** Windows asks for permission to do it. */
    readonly admin: boolean;
}

/** What the read-only check of this PC found, before anything was asked or changed. */
export interface LocalPcCheck {
    /** `ready`: agents can run here now; `needsSetup`: Intentic can get it ready; `cantRun`: no sandbox can run here. */
    readonly state: `checking` | `ready` | `needsSetup` | `cantRun` | `unknown`;
    readonly rows: readonly LocalCheckRow[];
    /** The machine in one line (`Windows 11, 16 GB memory, 214 GB free`), when the check could say. */
    readonly machine: string | undefined;
    /** Getting it ready needs a Windows restart. */
    readonly restart: boolean;
    /** Windows asks for permission once. */
    readonly admin: boolean;
    /** Everything getting it ready downloads, the sandbox's image included. */
    readonly downloadBytes: number;
    /** A rough estimate of the whole setup, the restart left out. */
    readonly minutes: number;
    /** The container engine the sandbox runs on here. */
    readonly engine: `dockerDesktop` | `intentic` | `native` | undefined;
}

/** The download of what agents need: started at first launch on an unmetered connection, before anything is asked. */
export interface LocalPrefetch {
    readonly state: `idle` | `running` | `paused` | `metered` | `done` | `failed`;
    readonly done: number;
    readonly total: number;
}

/** The PC's own setup (WSL, the container engine), started by the reader's "Set up this PC", with or without an account. */
export type LocalPcSetup =
    | { readonly state: `idle` }
    | { readonly state: `running`; readonly step: string | undefined; readonly percent: number; readonly needsYou?: boolean }
    | { readonly state: `waiting`; readonly for: `admin` | `restart` | `signOut`; readonly restartAt?: number }
    | { readonly state: `ready` }
    | { readonly state: `failed`; readonly reason: string };

/** The first task, written while the PC is set up. */
export interface LocalFirstTask {
    /** The folder it works on, as the reader picked it. */
    readonly folder: string;
    readonly text: string;
    readonly queuedAt: number;
    readonly state: `queued` | `sending` | `sent` | `failed`;
    readonly reason: string | undefined;
}

/** When to restart, while the PC's setup waits for one. `later` leaves it to the next time Windows starts. */
export type LocalRestartWhen = `now` | `in10Minutes` | `later`;

export interface LocalOnboardingHost {
    readonly check: Readonly<Ref<LocalPcCheck | undefined>>;
    readonly prefetch: Readonly<Ref<LocalPrefetch | undefined>>;
    readonly setup: Readonly<Ref<LocalPcSetup>>;
    readonly firstTask: Readonly<Ref<LocalFirstTask | undefined>>;
    /** The check again, after the reader changed something (a firmware setting, freed disk space). */
    recheck(): Promise<void>;
    /** "Set up this PC": the reader's one consent. Windows asks for permission once; a restart is asked for on its own. */
    setUp(): Promise<void>;
    pause(paused: boolean): Promise<void>;
    restart(when: LocalRestartWhen): Promise<void>;
    /** The system's folder dialog for the first task's folder: undefined when nothing was chosen. */
    pickFolder(): Promise<string | undefined>;
    queueFirstTask(task: { readonly folder: string; readonly text: string }): Promise<void>;
    clearFirstTask(): Promise<void>;
    /** A machine we host instead, for a PC that cannot run a sandbox: the workspace's setup, after sign-in. */
    useCloud(): Promise<void>;
    /** A product event, sent as the app sends its own: outcomes, ids and timings only, never a task's text or a path. */
    track(event: string, properties?: Readonly<Record<string, string | number | boolean>>): void;
}

/* THE FIRST TASK'S WAY INTO THE WORKSPACE: once this computer's sandbox is ready and the task's folder is in it, the app
   opens the workspace on the folder's project with `?task=<base64url(JSON LocalTaskHandoff)>`. The workspace starts one
   new chat with the text, sends it once (the id is remembered, so a reload sends nothing twice), takes the query off
   the address, and tells the app with `intentic://first-task?do=sent&id=<id>`, or `do=failed&id=<id>&reason=<text>`. */
export const TASK_QUERY = `task`;

export interface LocalTaskHandoff {
    readonly v: 1;
    readonly id: string;
    readonly text: string;
}

/* REPAIR (2026-10-09): an agent that runs in the app on this computer, outside every sandbox, for when a sandbox or its
   engine is down: the moment the workspace's own agents cannot help. Its hands are `ic` (doctor, fix, restart, rollback,
   the engine) and read-only checks of the PC; it has no shell and cannot touch the reader's files. Anything that changes
   something waits for the reader's Allow. Its model is reached through the platform with the reader's session, so it
   works with every sandbox down; signed out, it still runs the checks and offers the fixes, without the conversation. */

/** One tool call of Repair's, drawn as a row under its message. */
export interface LocalRepairTool {
    readonly name: string;
    readonly state: `running` | `done` | `failed` | `needsApproval` | `refused`;
    /** What it is doing or found, in the reader's words. */
    readonly summary: string;
    /** Full tool output for the Details disclosure. */
    readonly detail?: string;
    /** Set while it waits for the reader: answered with `answer`. */
    readonly approvalId: string | undefined;
}

export interface LocalRepairMessage {
    readonly id: string;
    readonly role: `user` | `assistant` | `tool`;
    readonly text: string;
    readonly tool: LocalRepairTool | undefined;
}

export interface LocalRepairSession {
    /** `offline`: no model could be reached; `signedOut`: checks and fixes only, no conversation; `waiting`: a tool needs Allow. */
    readonly state: `idle` | `thinking` | `waiting` | `offline` | `signedOut`;
    readonly messages: readonly LocalRepairMessage[];
    /** When Repair's daily allowance resets (ISO 8601), while it is spent; the checks and fixes still work meanwhile. */
    readonly allowanceResetsAt?: string;
}

/** Where Repair was opened from, which it starts looking at. */
export interface LocalRepairContext {
    /** The sandbox the reader was trying to reach. */
    readonly slug?: string;
    /** `recovery` (the workspace stopped answering), `setup` (a setup failed), `tray`, `link`, `agents`. */
    readonly from?: string;
    /** What the reader saw, as the opener said it. */
    readonly reason?: string;
}

export interface LocalRepairHost {
    readonly session: Readonly<Ref<LocalRepairSession>>;
    /** Opens a session, or carries on the one open, looking first at `context`. */
    start(context?: LocalRepairContext): Promise<void>;
    send(text: string): Promise<void>;
    answer(approvalId: string, allow: boolean): Promise<void>;
    /** Forget the conversation; nothing it did is undone. */
    reset(): Promise<void>;
}

/* A FOLDER'S WAY TO AN AGENT: "Work on this with an agent" asks the app in the window's own dialog (local/LocalProject.vue),
   and the folder goes into this computer's own sandbox, which the app makes once, after sign-in, in the background (its
   machine_sandbox.rs) and keeps; nothing waits on it, and a card in the window's corner says how far it and the folder
   are. A folder that already has a sandbox of its own keeps opening that one. The folder is never named here: the app
   always means the window's own (its project.rs). */

/** Why a folder cannot have a sandbox, by kind, drawn in the reader's words (local/projectWords.ts). */
export type LocalProjectRefusal =
    | { readonly kind: `disk` | `home` | `holdsHome` | `homes` | `aHome` | `system` }
    | { readonly kind: `inside` | `around`; readonly other: string };

/** What to beware of before a folder gets its sandbox. */
export type LocalProjectCaution = { readonly kind: `synced`; readonly service: string } | { readonly kind: `away` };

/** Why Docker is in the way of this computer's sandbox. */
export type LocalDockerReason = `notInstalled` | `notRunning` | `notAllowed`;

/**
 * Where this computer's own sandbox stands: nobody signed in yet (it is made after sign-in), Docker in the way (never
 * started for the reader), being made (its setup's running phase, the app's setupPlan.ts ids, and how far), stopped on
 * a question, ready, its container stopped, its setup failed, picked up after a quit, or gone from the account.
 */
export type LocalMachineState =
    | { readonly state: `signedOut` | `ready` | `stopped` | `interrupted` | `gone` }
    | { readonly state: `needsDocker`; readonly reason: LocalDockerReason }
    | { readonly state: `creating`; readonly phase: string | undefined; readonly step: string | undefined; readonly percent: number }
    | { readonly state: `waiting`; readonly for: `consent` | `restart` | `signOut` }
    | { readonly state: `failed`; readonly reason: string };

/** This computer's own sandbox, as every local window's card draws it. */
export type LocalMachineSandbox = LocalMachineState & {
    /** Its name on the account, once it has one. */
    readonly name: string | undefined;
    /** How many folders wait for it to be ready. */
    readonly waiting: number;
    /** Its last setup's transcript can be shown. */
    readonly hasLog: boolean;
};

/** This window's folder on its way into this computer's sandbox: in line, being added, its first copy, in, or not. */
export interface LocalFolderSandbox {
    /** Its name inside the sandbox's /work. */
    readonly name: string;
    readonly state: `queued` | `attaching` | `copying` | `ready` | `failed`;
    /** Why it could not be added, in the machine agent's own words. */
    readonly reason: string | undefined;
    /** The copy's own word for what it is doing, while it copies. */
    readonly status: string | undefined;
}

/** What the folder's dialog draws. */
export type LocalProjectPreview =
    // The folder has its sandbox already: the press opens it.
    | { readonly kind: `existing` }
    // A document opened on its own: a sandbox works on a whole folder.
    | { readonly kind: `document` }
    | { readonly kind: `refused`; readonly refusal: LocalProjectRefusal }
    | {
          readonly kind: `new`;
          // The folder's own name, which its name in the sandbox is derived from.
          readonly name: string;
          readonly path: string;
          // What the first copy carries, counted as the sync counts it; `more` when the count stopped short.
          readonly files: number;
          readonly bytes: number;
          readonly more: boolean;
          // Enough that the first copy is a long upload.
          readonly large: boolean;
          readonly cautions: readonly LocalProjectCaution[];
          // How far this computer's sandbox is: whether the copy starts now or once it is ready.
          readonly machine: LocalMachineState;
      };

/** What a press of the dialog's button came to: the folder in line for this computer's sandbox, or its own sandbox opened. */
export type LocalProjectStart = `queued` | `opened`;

/** What the card's buttons ask of the app: sign in, start Docker (on the reader's press, never by itself), try the setup
 * again, start its stopped container, make a new one in place of one that is gone, show the last setup's transcript. */
export type LocalMachineAction = `signIn` | `startDocker` | `retry` | `start` | `recreate` | `log`;

export interface LocalProjectHost {
    preview(): Promise<LocalProjectPreview>;
    /** This window's folder put in line for this computer's sandbox under `project`, its name in /work. Never waits. */
    attach(names: { readonly project: string }): Promise<LocalProjectStart>;
    /** This computer's own sandbox, once the app has said. */
    readonly machine: Readonly<Ref<LocalMachineSandbox | undefined>>;
    /** This window's folder on its way into it, while it is. */
    readonly folder: Readonly<Ref<LocalFolderSandbox | undefined>>;
    /** The folder's sandbox, opened on the folder. */
    open(): Promise<void>;
    act(action: LocalMachineAction): Promise<void>;
    /** The route of this shell where this computer's sandbox, its every step and anything it asks are drawn. */
    readonly detailsPath: string;
}

/** Every verb rejects with a sentence written for the reader, shown where the press was. */
export interface LocalHost {
    /** Whether this host reaches the app itself; the link-only host cannot read anything the app keeps. */
    readonly native: boolean;
    readonly views: readonly LocalView[];
    facts(): Promise<LocalFacts>;
    /** The recent folders and documents, newest first. */
    places(): Promise<readonly LocalPlace[]>;
    /**
     * Who is signed in and the account's sandboxes, as the workspace last told the app (desktop.ts
     * `announceDesktopRoster`): a local window cannot ask the platform itself. Empty before the workspace has said, and
     * after a sign-out.
     */
    roster(): Promise<LocalRoster>;
    /** Show `path`, a folder, in THIS window, in place of the folder it shows now. */
    point(path: string): Promise<void>;
    /** Open `path` where the app puts it: raised where a window shows it, handed to the folder window holding it, or a window of its own. */
    open(path: string): Promise<void>;
    /** The system's folder dialog, then the folder chosen shown in this window; nothing chosen changes nothing. */
    pickFolder(): Promise<void>;
    /** The system's file dialog, then the document chosen opened as `open` opens one. */
    pickFile(): Promise<void>;
    /** Take one entry off the recents; the folder or document itself is not touched. */
    forget(path: string): Promise<void>;
    /**
     * What this computer's AI tools say (the app's found.rs): the subscriptions signed in here and the folders their
     * histories name, newest first. Nothing where no app is behind the page.
     */
    found(): Promise<LocalFound>;
    /** Platform sign-in, in the default browser: the account comes back to the app, which opens the workspace. */
    signIn(): Promise<void>;
    /** The workspace (agents and sandboxes), in this window's place, at its root or a path under it. */
    openWorkspace(path?: string): Promise<void>;
    /**
     * Who is signed in, asked of the platform now (client/auth/useAccount.ts): null when nobody is. Rejects when the
     * platform cannot be reached, which says nothing about whether anyone is.
     */
    account(): Promise<User | null>;
    /** A new name, or a new picture as a data URL, as Settings › Profile saves them. */
    updateAccount(change: { readonly name?: string; readonly image?: string }): Promise<void>;
    /** Signs the account out on the platform, for the workspace too: the app forgets the session and the sandboxes. */
    signOut(): Promise<void>;
    /** A sandbox for this window's folder, made here; absent where the app cannot (a page with no app behind it). */
    readonly project?: LocalProjectHost;
    /** What a new computer needs before agents run on it, and the first task; absent where no app is behind the page. */
    readonly onboarding?: LocalOnboardingHost;
    /** Repair, the agent that runs on this computer outside every sandbox; absent where no app is behind the page. */
    readonly repair?: LocalRepairHost;
}

/* THE ACCOUNT'S ANSWERS, as the app hands their text over (its src/account.ts): Better Auth's, read as useAuth.ts reads
   them. Text that is not JSON (a proxy's error page) says nothing, as an answer out of shape says nothing. */

// `get-session` answers `{ session, user }`, or `null` for nobody. Only what the editor's User holds is kept; a user
// with no name or picture has them empty, and an answer out of shape is nobody rather than half someone.
const SessionAnswerSchema = z
    .object({ user: UserSchema.extend({ name: z.string().catch(``), image: z.string().nullable().catch(null) }) })
    .nullable();

export const accountOfSession = (text: string): User | null => {
    try {
        return SessionAnswerSchema.safeParse(JSON.parse(text)).data?.user ?? null;
    } catch (error) {
        if (error instanceof SyntaxError) {
            return null;
        }
        throw error;
    }
};

// A refusal's sentence, which Better Auth and oRPC both say as `message`.
const RefusalSchema = z.object({ message: z.string().min(1) });

export const refusalOf = (text: string): string | undefined => {
    try {
        return RefusalSchema.safeParse(JSON.parse(text)).data?.message;
    } catch (error) {
        if (error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
};

declare global {
    interface Window {
        __INTENTIC_LOCAL_HOST__?: LocalHost;
    }
}

const nothing = (): Promise<void> => Promise.resolve();

/** What any local window can do without the app's host: ask by link for a dialog, which opens in a window of its own. */
export const LINK_HOST: LocalHost = {
    native: false,
    views: [],
    facts: () => Promise.resolve({ accountSeen: false, homeFolder: `` }),
    places: () => Promise.resolve([]),
    roster: () => Promise.resolve({ account: null, sandboxes: [] }),
    point: nothing,
    open: nothing,
    pickFolder: () => {
        askLocalApp(`open-folder`);
        return Promise.resolve();
    },
    pickFile: () => {
        askLocalApp(`open-file`);
        return Promise.resolve();
    },
    forget: nothing,
    found: () => Promise.resolve(NOTHING_FOUND),
    signIn: nothing,
    openWorkspace: nothing,
    account: () => Promise.resolve(null),
    updateAccount: nothing,
    signOut: nothing,
};

export const localHost = (): LocalHost => window.__INTENTIC_LOCAL_HOST__ ?? LINK_HOST;
