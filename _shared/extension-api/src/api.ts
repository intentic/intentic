import type { sandboxContract } from "@intentic/sandbox-contract";
import type { ContractRouterClient } from "@orpc/contract";
import type { Component } from "vue";
import type { DiffPayload } from "./diff.js";
import type { CapabilityFacts, RepoFacts } from "./facts.js";

// The host API an extension programs against; there is no ambient global. Arrives as
// activate(api, context); everything registered returns a Disposable pushed onto context.subscriptions.

export interface Disposable {
    dispose(): void;
}

// One sidebar element a view contributes, routed at /ext/<viewId>/<key> and rendered by the view's
// component with `repo` (+ props) bound.
export interface Activation {
    // Stable per-view key (usually the repo name); the route segment, so deep links survive reloads.
    readonly key: string;
    readonly title: string;
    // An icon name from the host's icon set; absent renders the title's initials.
    readonly icon?: string | undefined;
    // One or two characters drawn in place of the icon, for a tile that stands for one named thing (the open
    // project); wins over `icon` while set. Longer strings are cut to two.
    readonly monogram?: string | undefined;
    // Absent for capability-driven elements, which have no repo to root at.
    readonly repo?: string | undefined;
    readonly props?: Record<string, unknown> | undefined;
}

// What a sidebar tile may say before it's opened: a number and how alarmed to be. Non-empty also keeps
// the tile seated in the rail instead of the More menu.
export interface ViewBadge {
    // How many; omitted or 0 means no number. The host renders anything above 99 as "99+".
    readonly count?: number | undefined;
    // A glyph shown instead of a number, for a pending action whose size doesn't matter. Neither renders nothing.
    readonly mark?: string | undefined;
    // neutral: an inventory, nothing owed.
    // info: the resting tone for actionable work.
    // warning: a risk being carried.
    // danger: something is broken; use sparingly.
    // Absent means info.
    readonly tone?: "neutral" | "info" | "warning" | "danger" | undefined;
    // What happened and how much; rendered after the view's name, so phrase it as a continuation, not a sentence.
    readonly tooltip?: string | undefined;
    /* WORK IN FLIGHT BEHIND THIS TILE RIGHT NOW ("2 running"), phrased as a continuation like `tooltip`. */
    readonly running?: string | undefined;
}

// One cached read, shared by `ViewRegistration.warm` and `api.sandbox.fetch`. `staleTime`/`gcTime` are
// optional; both default to the host's.
export interface HostQuery<T = unknown> {
    // Must be scoped by api.sandbox.key(...), so nothing bleeds across a sandbox switch.
    readonly queryKey: readonly unknown[];
    readonly queryFn: () => Promise<T>;
    readonly staleTime?: number | undefined;
    readonly gcTime?: number | undefined;
}

// A view's runtime registration; `id`, `label` and `surface` must match a `contributes.views` entry in
// the approved manifest.
export interface ViewRegistration {
    readonly id: string;
    // The view family's human name, distinct from an Activation's per-repo `title`.
    readonly label: string;
    // rail: the always-visible left column, a permanently seated tile.
    // directory: a per-repo panel opened from the Workspace tree.
    // sandbox: a tab on the Sandbox hub, for inspecting the box itself.
    readonly surface: "rail" | "directory" | "sandbox";
    // Evidence-based detection over the public facts; a throwing detect contributes nothing that round.
    // Must not write reactive state (runs inside the host's render computed).
    readonly detect: (repos: readonly RepoFacts[], capabilities: readonly CapabilityFacts[]) => Activation[];
    // Read inside the host's computed, so a ref read here re-renders the tile; called on every render, so
    // keep it cheap, pure and non-writing. Requires `badge: true` on the manifest entry.
    readonly badge?: ((activation: Activation) => ViewBadge | undefined) | undefined;
    // Declare the query (not a fetcher) the loader should read ahead of need; use the same key your view's
    // `useQuery` reads. A wish, never a guarantee; called every loader beat, so keep it cheap and pure.
    readonly warm?: (() => readonly HostQuery[]) | undefined;
    // A fallback view's activations are dropped for repos already claimed by a non-fallback one.
    readonly fallback?: true | undefined;
    // An auxiliary view adds a surface beside the repo's other views instead of claiming it.
    readonly auxiliary?: true | undefined;
    // Lazily imported root component, rendered with `repo` (+ props) bound.
    readonly view: () => Promise<Component>;
}

// A custom file viewer's registration; `id` must match a `contributes.viewers` manifest entry. The host
// resolves an open file to it and renders `component` with the fetched content bound.
export interface ViewerRegistration {
    readonly id: string;
    readonly component: () => Promise<Component>;
    // Draws two versions of the file as one, what changed marked in place; rendered with `before` and `after` blobs
    // and `path`. Honoured only when the manifest entry declares `compare: true`.
    readonly compare?: () => Promise<Component>;
}

// What a directory row offers when a provider has a document for it: the tree's icon, and the tab's
// title. An unknown `icon` renders nothing rather than failing the registration.
export interface DocumentOffer {
    readonly icon: string;
    // Names the action on the row ("Open architecture doc"); read as a tooltip on an icon.
    readonly tooltip: string;
    // The tab's label; keep it short, the strip already shows the directory's name beside it.
    readonly title: string;
    // Keeps the icon visible outside hover, for evidence rather than an action found by sweeping.
    readonly evidence?: boolean;
}

// An extension's answer to "there is something to read about this directory", keyed by path rather
// than repo. The host owns the tab; `view` mounts beside the files it describes.
export interface DocumentProviderRegistration {
    // Must match a `contributes.documents` entry in the approved manifest.
    readonly id: string;
    // Whether this provider has a document for a path ("" is the workspace root). Called on every tree
    // render, so it must be a lookup, never a fetch; a throwing detect offers nothing.
    readonly detect: (path: string) => DocumentOffer | undefined;
    // Lazily imported component, rendered with `path` bound.
    readonly view: () => Promise<Component>;
}

// Everything that decides who serves a turn. `label` lets a view show the choice without its own
// catalog; everything after it is an optional pin (absent means the daemon resolves it).
export interface PickedModel {
    // An AgentProvider, a model endpoint id, or an installed ACP agent's id; the set grows with what's connected.
    readonly provider: string;
    readonly model: string;
    readonly label: string;
    // Which connected account runs the turn; absent means whichever comes first.
    readonly account?: string | undefined;
    // What the shell calls that account; absent covers both a disconnected pin and an unread account list.
    readonly accountLabel?: string | undefined;
    // `native` or `claude-code`; absent means native, the only answer for most providers.
    readonly harness?: string | undefined;
    // One of the provider's reasoning tiers ("low", "high", "max"); absent means the model's own default.
    readonly effort?: string | undefined;
    // What the shell calls that tier ("X-High"); absent whenever `effort` is.
    readonly effortLabel?: string | undefined;
    /* WHAT THE PRESS DOES TO THE ATTEMPT THE PICKER WAS OPENED OVER (`attempt` on `pick`): continue it, or start over from it. */
    readonly resume?: "continue" | "start-over" | undefined;
    /* WHETHER THE MODEL REASONS BEFORE IT ANSWERS, where that is a choice it offers. */
    readonly thinking?: boolean | undefined;
    /* WHETHER THE WORK IS BOUGHT AT THE FASTER RATE, for a higher price. */
    readonly fast?: boolean | undefined;
}

export type SettingValue = string | number | boolean;

export interface ProcessStatus {
    readonly name: string;
    readonly running: boolean;
    readonly port?: number | undefined;
    readonly previewUrl?: string | undefined;
}

export interface IntenticApi {
    // The host's @intentic/extension-api version, checked against `engines.intentic`.
    readonly apiVersion: string;
    readonly views: {
        register(view: ViewRegistration): Disposable;
    };
    // Custom file viewers (contributes.viewers); the host owns the fetch and open-file lifecycle and
    // renders the registered component. See ViewerRegistration.
    readonly viewers: {
        register(viewer: ViewerRegistration): Disposable;
    };
    // Per-directory documents (contributes.documents); the extension says which directories it can
    // explain, the host draws the tree affordance and owns the tab. See DocumentProviderRegistration.
    readonly documents: {
        register(provider: DocumentProviderRegistration): Disposable;
        // Opens one of this extension's documents for a path with no row of its own (e.g. the workspace root).
        // `id` must be a registered provider with an offer for `path`, or nothing opens.
        open(id: string, path: string): void;
    };
    readonly commands: {
        // `command` must match a `contributes.commands` entry in the approved manifest.
        register(command: string, handler: (...args: unknown[]) => unknown): Disposable;
        execute(command: string, ...args: unknown[]): Promise<unknown>;
    };
    // The extension's own declared settings, persisted daemon-side and shared across the owner's browsers.
    readonly settings: {
        get(key: string): SettingValue | undefined;
        set(key: string, value: SettingValue): Promise<void>;
        onDidChange(listener: (key: string) => void): Disposable;
    };
    // The authenticated transport to the sandbox daemon; auth is injected host-side. Every door is gated
    // by the manifest's `permissions.sandbox` allowlist.
    readonly sandbox: {
        // The daemon's contract, typed: a call names a procedure instead of a URL, checked at build time.
        // Gated the same way as `request`/`json`, on the resolved method and path.
        readonly rpc: ContractRouterClient<typeof sandboxContract>;
        request(path: string, init?: RequestInit): Promise<Response>;
        json<T>(path: string, init?: RequestInit): Promise<T>;
        // Reads through the host's cache from outside a component (e.g. a module-level badge timer);
        // concurrent callers of one key share a request. Gated exactly as `json` is.
        fetch<T>(query: HostQuery<T>): Promise<T>;
        // Whether the active sandbox is reachable; reactive when read inside a computed.
        reachable(): boolean;
        // A cache key scoped to the active sandbox; required prefix for every host-provided vue-query key.
        key(...parts: readonly string[]): readonly unknown[];
        // The daemon's public tunnel origin, for externally-shareable URLs; undefined until the sandbox is registered.
        origin(): string | undefined;
        // The signed-in user's trust tier, reactive like `reachable`. For affordances only: every route is
        // still floored by the daemon independently. A desk sees only the chat and its own conversations; a view
        // reading files or the fleet for one draws a refusal.
        role(): "owner" | "maintainer" | "collaborator" | "viewer" | "desk";
        // The address this browser should frame or open a preview at, given the public one the daemon handed out (a
        // forwarded port's `previewUrl`, a panel's): its loopback twin when the app is on the daemon's loopback lane
        // and that lane answers as this sandbox's preview proxy, else the public address as given. On the sandbox's
        // own machine the difference is hundreds of milliseconds a request, so never frame the public address directly.
        previewAddress(url: string): Promise<string>;
    };
    readonly workspace: {
        // The open project's repositories only (see `project`); everything when no project is open.
        repos(): readonly RepoFacts[];
        capabilities(): readonly CapabilityFacts[];
        onDidChange(listener: () => void): Disposable;
        // Which project the whole shell is looking at: one repository's id, or undefined for everything. Sandbox-wide:
        // the workspace roots at it, the agents board files conversations under it, and `repos()` above is narrowed to
        // it, so a view keyed by repository narrows without asking. Reactive when read inside a computed.
        project(): string | undefined;
        setProject(project: string | undefined): void;
        onDidChangeProject(listener: (project: string | undefined) => void): Disposable;
        // Whether a workspace-relative path is in view: true while no project is open, else only for the project
        // and what is inside it. What a view keyed by repository filters its own rows by; reactive inside a computed.
        inProject(path: string): boolean;
        // Fires when a ref moves in a repo (commit, branch, checkout, rebase) — a change `.git` watching can't
        // see as a file path. `repos` are root-relative ids.
        onDidChangeRefs(listener: (repos: readonly string[]) => void): Disposable;
        // Fires for a write under your declared `contributes.files` prefixes; `paths` are the matching ones.
        // Fires with your whole declaration when the host can't say what moved.
        onDidChangeFiles(listener: (paths: readonly string[]) => void): Disposable;
        // Opens a diff in the editor area, beside the files it's about. Re-opening the same key+scope+path
        // focuses the existing tab instead of stacking a new one.
        openDiff(payload: DiffPayload): void;
        // Fills a diff opened with `pending`. Refreshes only: a tab the user has since closed or replaced takes
        // nothing.
        fillDiff(payload: DiffPayload): void;
        // Reads and writes workspace files without the encoding boilerplate. Gated exactly as
        // `sandbox.request`/`sandbox.json`: the manifest grant is unchanged.
        // The file's text, or undefined when it doesn't exist — a valid first state, not a thrown error.
        file(path: string): Promise<string | undefined>;
        // Parsed as a JSON object, or undefined if absent, truncated, or not an object. One tolerant reader:
        // a bad file is skipped, never a thrown error.
        readJson<T>(path: string): Promise<T | undefined>;
        // Creates or replaces a file. Throws on failure, unlike the reads: a silent no-op would lose what the
        // caller was told was saved.
        write(path: string, body: string): Promise<void>;
    };
    // The extension's own declared background processes; names outside the manifest are refused.
    readonly processes: {
        status(name: string): Promise<ProcessStatus>;
        start(name: string): Promise<void>;
        stop(name: string): Promise<void>;
    };
    // The shell's one global terminal panel; extensions aim it at a tmux session, the host owns the panel.
    readonly terminal: {
        // Opens the panel focused on a tmux session, starting or attaching it.
        open(session: string): void;
        // Shows or hides the panel without focusing a session.
        setOpen(open: boolean): void;
    };
    // The shell's chat, the way `terminal` is the shell's terminal panel: the extension names a
    // transcript, the host owns the tab.
    readonly chat: {
        // Opens (or focuses) the tab for a stored session id. A session the daemon no longer holds opens an
        // empty tab rather than failing.
        openSession(sessionId: string): void;
        /* Open (or focus) the docked chat for a fleet agent by its id: the same thing a card press on the agents board does. */
        openAgent(agentId: string): void;
        /* AIM A NEW CHAT AT A WORKFLOW: the host opens a session exactly as "New agent" does, with the composer's workflow badge set to this design. */
        composeWorkflow(workflowId: string): void;
        // Like `composeWorkflow`, but arms the composer's loop badge: the next message becomes the loop's
        // goal, and Send starts it running.
        composeLoop(loopId: string): void;
    };
    // Which model a run this extension starts will spend; the host owns the picker, a live read of every
    // connected provider's catalog. Covers provider, account, harness and model together.
    readonly models: {
        // The sandbox's default model for a job `role` (e.g. "acceptance-run"), falling back to the owner's
        // chat model; reactive in a computed.
        agentRun(role: string): PickedModel;
        // Renders a stored pin (bare ids) back into a display-ready `PickedModel`, so a saved choice doesn't
        // need its own catalog. Reactive: reflects a renamed model or disconnected account.
        describe(selection: {
            readonly provider: string;
            readonly model: string;
            readonly account?: string | undefined;
            readonly harness?: string | undefined;
            readonly effort?: string | undefined;
            readonly thinking?: boolean | undefined;
            readonly fast?: boolean | undefined;
        }): PickedModel;
        /* Open the picker over `anchor`, a popover on desktop, a sheet on mobile, starting on the selection the caller is holding. */
        pick(options: {
            readonly anchor: HTMLElement;
            readonly provider: string;
            readonly model: string;
            readonly account?: string | undefined;
            readonly harness?: string | undefined;
            readonly effort?: string | undefined;
            readonly thinking?: boolean | undefined;
            readonly fast?: boolean | undefined;
            /* THE VERB ON THE PANEL'S OWN BUTTON — "Fix with agent", "Run all 21 stories", "Save this step". */
            readonly action?: string | undefined;
            /* OFFER THE MODEL'S OWN RUN SETTINGS — reasoning effort, extended thinking, speed. */
            readonly chooseRun?: boolean;
            /* THE ATTEMPT ALREADY MADE AT WHAT THIS RUN WOULD ANSWER, when there is one: a line naming it, and whether it can be continued from here. */
            readonly attempt?: { readonly summary: string; readonly continuable: boolean } | undefined;
        }): Promise<PickedModel | undefined>;
    };
    // Navigates the shell to an app path (e.g. "/capabilities", "/ext/<view>/<key>").
    readonly navigate: (path: string) => void;
    // The same path as a browser address, for `<a href>` so a navigational row is a real link, not just a
    // click handler. Use with `browserOwnsClick` for modified clicks.
    readonly href: (path: string) => string;
    // The URL as a view's own state, so what's on screen can be linked. A view's route space is the query
    // only (`:key` already names the activation).
    readonly route: {
        // The current query, flattened; a repeated key takes its first value.
        query(): Readonly<Record<string, string>>;
        // Merges a patch in; a key set to `undefined` is removed. Replaces the history entry by default, or
        // pushes one when `push` is set.
        setQuery(patch: Readonly<Record<string, string | undefined>>, options?: { readonly push?: boolean }): void;
    };
    readonly theme: {
        mode(): "light" | "dark";
        onDidChange(listener: (mode: "light" | "dark") => void): Disposable;
    };
    // Who the screens are written for, the way `theme` says how they are lit: a developer reads git's own words
    // (branch, land, commit, diff) and a maker reads plain ones (draft, accept, version, what changed) over the same
    // mechanisms. Reactive when read inside a computed. A view that never asks renders as it always has.
    readonly audience: {
        current(): "developer" | "maker";
        onDidChange(listener: (audience: "developer" | "maker") => void): Disposable;
    };
}

export interface ExtensionContext {
    readonly extensionId: string;
    // Disposables pushed here are disposed on deactivation, in reverse order.
    readonly subscriptions: Disposable[];
}

/** Messages as they are authored: nested objects down to strings. */
export type MessageTree = { readonly [key: string]: string | MessageTree };

/**
 * An extension's own words. The host mounts them under `ext.<extension id>`, so nothing an extension writes can
 * collide with the app's keys or another extension's, and `extensionT` from @intentic/extension-ui reads them back
 * with the namespace already applied.
 *
 * `base` is English and is part of the bundle; every other language is fetched only if the reader is in it. The host
 * loads the right one BEFORE calling `activate`, so a contribution's title is never briefly in the wrong language.
 */
export interface ExtensionMessages {
    /** English, imported statically — it is the fallback for a key no translation carries, which cannot be a fetch. */
    readonly base: MessageTree;
    /** One chunk per language, keyed by its code. Never called for English. */
    readonly load: (locale: string) => Promise<{ readonly default: MessageTree }>;
}

// The bundle's default (or named) exports: `activate` runs once after the engines check, `deactivate`
// runs before the host discards the extension.
export interface ExtensionModule {
    activate(api: IntenticApi, context: ExtensionContext): void | Promise<void>;
    deactivate?(): void | Promise<void>;
    /** Absent in an extension that ships one language, which the host then renders as written. */
    readonly messages?: ExtensionMessages;
}
