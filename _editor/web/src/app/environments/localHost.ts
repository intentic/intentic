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
}

/* A FOLDER'S OWN SANDBOX: "Work on this with an agent" asks the app in the window's own dialog (local/LocalProject.vue),
   and the sandbox is built on this computer while the reader keeps working, drawn as a card over the folder. The folder
   is never named here: the app always means the window's own (its project.rs). */

/** Why a folder cannot have a sandbox, by kind, drawn in the reader's words (local/projectWords.ts). */
export type LocalProjectRefusal =
    | { readonly kind: `disk` | `home` | `holdsHome` | `homes` | `aHome` | `system` }
    | { readonly kind: `inside` | `around`; readonly other: string };

/** What to beware of before a folder gets its sandbox. */
export type LocalProjectCaution = { readonly kind: `synced`; readonly service: string } | { readonly kind: `away` };

/** What the folder's dialog draws. */
export type LocalProjectPreview =
    // The folder has its sandbox already: the press opens it.
    | { readonly kind: `existing` }
    // A document opened on its own: a sandbox works on a whole folder.
    | { readonly kind: `document` }
    | { readonly kind: `refused`; readonly refusal: LocalProjectRefusal }
    | {
          readonly kind: `new`;
          // The folder's own name, which the sandbox is named after.
          readonly name: string;
          readonly path: string;
          // What the first copy carries, counted as the sync counts it; `more` when the count stopped short.
          readonly files: number;
          readonly bytes: number;
          readonly more: boolean;
          // Enough that the first copy is a long upload.
          readonly large: boolean;
          readonly cautions: readonly LocalProjectCaution[];
          // The workspace's session is here; without it the press signs in first, in the workspace.
          readonly signedIn: boolean;
          // A sandbox is being set up on this computer already, and they go one at a time.
          readonly busy: boolean;
      };

/** A folder's sandbox being built in this window, as its card draws it. */
export interface LocalProjectBuild {
    /** The sandbox's name. */
    readonly name: string;
    /**
     * `building` while it runs; `waiting` on the reader (something this computer needs, answered on This computer);
     * `ready` once the folder's copy is in its sandbox; `failed` or `stopped` as it ended.
     */
    readonly state: `building` | `waiting` | `ready` | `failed` | `stopped`;
    /** The setup's running phase (the app's setupPlan.ts ids), which the house is drawn by. */
    readonly phase: string | undefined;
    /** How far into the running phase it is (0..1), where the phase measures it (the image's download). */
    readonly phaseProgress: number;
    /** The running step in the setup's own words, for the reader who wants what is actually happening. */
    readonly step: string | undefined;
    readonly percent: number;
    /** Milliseconds left at this machine's pace so far; undefined while there is nothing honest to say. */
    readonly remainingMs: number | undefined;
    /** Why it stopped, in the setup's own words. */
    readonly error: string | undefined;
}

/** What a press of "Create sandbox" came to. */
export type LocalProjectStart = `building` | `signIn` | `opened`;

export interface LocalProjectHost {
    preview(): Promise<LocalProjectPreview>;
    /** The sandbox made, named as the page derived from the folder's name, and its build started in this window. */
    create(names: { readonly name: string; readonly project: string }): Promise<LocalProjectStart>;
    /** The build in this window, while there is one to draw. */
    readonly build: Readonly<Ref<LocalProjectBuild | undefined>>;
    /** The built sandbox, opened on the folder. */
    open(): Promise<void>;
    /** The build again, from the start, on the same sandbox. */
    retry(): Promise<void>;
    /** Stops the build and everything it started. */
    stop(): Promise<void>;
    /** Puts a finished or failed build's card away. */
    dismiss(): void;
    /** The route of this shell where the build's every step, its log and anything it asks of the reader are drawn. */
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
     * Who is signed in, asked of the platform now (shell/useAccount.ts): null when nobody is. Rejects when the
     * platform cannot be reached, which says nothing about whether anyone is.
     */
    account(): Promise<User | null>;
    /** A new name, or a new picture as a data URL, as Settings › Profile saves them. */
    updateAccount(change: { readonly name?: string; readonly image?: string }): Promise<void>;
    /** Signs the account out on the platform, for the workspace too: the app forgets the session and the sandboxes. */
    signOut(): Promise<void>;
    /** A sandbox for this window's folder, made here; absent where the app cannot (a page with no app behind it). */
    readonly project?: LocalProjectHost;
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
