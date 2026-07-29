import type { Component } from "vue";
import type { CapabilityFacts, RepoFacts } from "./facts.js";

/* The host API an extension programs against. There is no ambient global: the implementation arrives as the
 * `activate(api, context)` argument, and everything an extension registers is returned as a Disposable pushed
 * onto context.subscriptions so deactivation can unwind it. */

export interface Disposable {
    dispose(): void;
}

// One sidebar element a view contributes: routed at /ext/<viewId>/<key> (the key segment is dropped when it
// equals the view id — a singleton view links to /ext/<viewId>), rendered by the view's component with
// `repo` (+ props) bound.
export interface Activation {
    // Stable per-view key (usually the repo name) — the route segment, so deep links survive reloads.
    readonly key: string;
    readonly title: string;
    // An icon name from the host's icon set; absent ⇒ the rail renders the title's initials.
    readonly icon?: string | undefined;
    // The repo this element is rooted at — the fallback-dedup subject and the component's `repo` prop. Absent
    // for capability-driven elements, which aren't rooted at any repo.
    readonly repo?: string | undefined;
    readonly props?: Record<string, unknown> | undefined;
}

// A view's runtime registration — for third-party extensions, `id`, `label` and `surface` must match a
// `contributes.views` entry in the approved manifest or the host refuses the registration.
export interface ViewRegistration {
    readonly id: string;
    // The view family's human name (distinct from an Activation's per-repo `title`) — labels the directory
    // panel's surface switch when a repo activates several.
    readonly label: string;
    // Where the view's activations mount. `rail` is the always-visible left column — a place the user ACTS
    // from, so a tile there must earn a permanently occupied slot. `directory` is a per-repo panel opened from
    // the Workspace tree. `sandbox` is a tab on the Sandbox hub, where the subject is the box itself (its
    // logs, its status, its consumption) — inspected occasionally rather than worked in, so it costs a tab in
    // a scrolling word-labelled strip instead of an icon in the rail's fixed budget.
    readonly surface: "rail" | "directory" | "sandbox";
    // Evidence-based detection over the public facts — one activation per sidebar element. Called on every
    // facts poll; a throwing detect contributes nothing that round.
    readonly detect: (repos: readonly RepoFacts[], capabilities: readonly CapabilityFacts[]) => Activation[];
    // A fallback view's activations are dropped for repos already claimed by a non-fallback one.
    readonly fallback?: true | undefined;
    // An AUXILIARY view adds a surface BESIDE whatever else serves the repo instead of replacing it — a test
    // runner, a docs browser. Its activations render and mark the directory manageable exactly like any other,
    // but they do not claim the repo, so the fallback view (the raw dev-server preview) survives alongside.
    // Claiming is for a view that subsumes the fallback: `apps` renders the preview URLs itself, so dropping
    // the preview tile beside it is right; a test runner renders no preview, so dropping it would be a loss.
    readonly auxiliary?: true | undefined;
    // Lazily imported root component, rendered with `repo` (+ props) bound.
    readonly view: () => Promise<Component>;
}

// A custom file viewer's runtime registration — `id` must match a `contributes.viewers` entry in the approved
// manifest (the host reads the file extensions + fetch kind from there). The host resolves an open file to this
// viewer, fetches its content, and renders `component` with `{ path, text?, blob? }` bound.
export interface ViewerRegistration {
    readonly id: string;
    readonly component: () => Promise<Component>;
}

export type SettingValue = string | number | boolean;

export interface ProcessStatus {
    readonly name: string;
    readonly running: boolean;
    readonly port?: number | undefined;
    readonly previewUrl?: string | undefined;
}

export interface IntenticApi {
    // The host's @intentic/extension-api version — what `engines.intentic` was checked against.
    readonly apiVersion: string;
    readonly views: {
        register(view: ViewRegistration): Disposable;
    };
    // Custom file viewers (contributes.viewers) — the host owns the fetch + open-file lifecycle and renders the
    // registered component with the file's content; the extension only renders. See ViewerRegistration.
    readonly viewers: {
        register(viewer: ViewerRegistration): Disposable;
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
    // The authenticated transport to the sandbox daemon's routes — auth is injected host-side; an extension
    // never sees tokens. Reach is scoped: request/json are gated by the manifest's `permissions.sandbox`
    // allowlist, so a call to an undeclared method+path throws rather than reaching the whole daemon.
    readonly sandbox: {
        request(path: string, init?: RequestInit): Promise<Response>;
        json<T>(path: string, init?: RequestInit): Promise<T>;
        // Whether the active sandbox is currently reachable — reactive when read inside a computed, so it
        // drives host-provided vue-query `enabled` options.
        reachable(): boolean;
        // A cache key scoped to the ACTIVE sandbox — the required prefix for every host-provided vue-query
        // key, so caches never bleed across a sandbox switch.
        key(...parts: readonly string[]): readonly unknown[];
        // The daemon's base URL (its public tunnel origin), for building externally-shareable URLs like webhook
        // endpoints. Undefined until the sandbox has registered its address. Not needed for `request`/`json`
        // (those take a path and inject auth) — only when the raw origin must be shown to the user.
        origin(): string | undefined;
    };
    readonly workspace: {
        repos(): readonly RepoFacts[];
        capabilities(): readonly CapabilityFacts[];
        onDidChange(listener: () => void): Disposable;
    };
    // The extension's OWN declared background processes — names outside the manifest are refused.
    readonly processes: {
        status(name: string): Promise<ProcessStatus>;
        start(name: string): Promise<void>;
        stop(name: string): Promise<void>;
    };
    // The shell's ONE global terminal panel — extensions aim it at a tmux session (a capability job, a dev
    // server, an agent terminal); the host owns the panel itself.
    readonly terminal: {
        // Open the panel focused on a tmux session (starting/attaching it).
        open(session: string): void;
        // Show or hide the panel without focusing a session.
        setOpen(open: boolean): void;
    };
    // Navigate the shell to an app path (e.g. "/capabilities", "/ext/<view>/<key>").
    readonly navigate: (path: string) => void;
    readonly theme: {
        mode(): "light" | "dark";
        onDidChange(listener: (mode: "light" | "dark") => void): Disposable;
    };
}

export interface ExtensionContext {
    readonly extensionId: string;
    // Disposables pushed here are disposed on deactivation, in reverse order.
    readonly subscriptions: Disposable[];
}

// The shape of the bundle's default export (or its named exports): `activate` runs once after the engines
// check; `deactivate` runs before the host discards the extension.
export interface ExtensionModule {
    activate(api: IntenticApi, context: ExtensionContext): void | Promise<void>;
    deactivate?(): void | Promise<void>;
}
