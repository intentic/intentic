import type { sandboxContract } from "@intentic/sandbox-contract";
import type { Conversion, Granularity } from "@intentic/sandbox-contract/documents";
import type { ToolEffect } from "@intentic/sandbox-contract/peer-mcp-server";
import type { ContractRouterClient } from "@orpc/contract";
import type { Disposable } from "./disposable.js";

// The effect vocabulary the daemon's own tools and every device's tools declare, re-exported so a tool here says what it
// does in the same words.
export type { ToolEffect };

// Backend counterpart to `IntenticApi` (api.ts); a manifest `server` bundle's `activateServer` runs in a node process
// shared by every enabled extension, separate from the daemon. Mediates only the extension's route namespace (mount)
// and its reach into daemon routes (`daemon.*`, gated by `permissions.daemon`).

// The card a tool server was mounted for (`contributes.tools.perCard`): its id, which names the server the agent sees,
// and its settings as the daemon holds them now, secrets included, every value a string. Handed with every call, so a
// switch flipped on the card applies to the next call without anything to invalidate.
export interface ToolCard {
    readonly id: string;
    readonly config: Readonly<Record<string, string>>;
}

// One piece of what a tool answers, as MCP carries it.
export type ToolContent =
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string };

// A tool's whole answer. `isError` marks a refusal or a failure the model should read rather than a transport error.
export interface ToolResult {
    readonly content: readonly ToolContent[];
    readonly isError?: boolean;
}

// What one call is handed beside its arguments.
export interface ToolCallContext {
    // Aborted when the agent's client gives up on the call, or the host's deadline for it passes.
    readonly signal: AbortSignal;
    // The conversation the calling turn belongs to, when it has one.
    readonly conversationId?: string | undefined;
}

export interface ToolDefinition {
    // The name the model calls it by, under the server's own `mcp__<server>__` prefix.
    readonly name: string;
    readonly description: string;
    // A JSON Schema object for the arguments (`z.toJSONSchema(schema)` produces one).
    readonly inputSchema: Readonly<Record<string, unknown>>;
    // What one call can do to the world: `read` changes nothing, so a runtime may run several at once and allow it where
    // writes are held; `write` changes something recoverable; `destructive` may lose something. Listed to the model as
    // MCP annotations. Undeclared, it is listed with none, which Claude Code reads as a destructive write run alone.
    readonly effect?: ToolEffect;
    // A string answers as text, a ToolResult as itself, anything else as its JSON; a throw answers as a tool error.
    readonly call: (args: Readonly<Record<string, unknown>>, context: ToolCallContext) => Promise<ToolResult | string | unknown> | ToolResult | string | unknown;
}

// One request into this extension's `/x/<id>` namespace, prefix already stripped. Return `undefined` for "not mine":
// the host answers 404.
export type BackendRouteHandler = (request: Request) => Promise<Response | undefined>;

// An extension's own setting values, keyed as its manifest's `contributes.settings` declares them.
export type ExtensionSettingValues = Readonly<Record<string, string | number | boolean>>;

// A file the extension keeps in its own state directory, read through the conversions its shape has had and written
// with what a newer version of the extension put in it kept in place: the evolution `sandboxDocument` gives the browser
// half, and the daemon's own stores have. A file that exists but this version cannot read is left alone: `update`
// rejects rather than writing the fallback over it.
export interface ServerDocument<T> {
    // Today's value: the file converted and parsed; the fallback when it is absent or this version cannot read it.
    read(): Promise<T>;
    // Read-change-write, serialized against every other handle on the same file, written whole by a rename so a reader
    // never sees half of it. Answers what is stored afterwards; returning `current` unchanged writes nothing.
    update(change: (current: T) => T): Promise<T>;
}

// What a stored document holds before its parse: JSON, after the conversions its shape has had.
export type StoredJson = string | number | boolean | null | readonly StoredJson[] | { readonly [key: string]: StoredJson };

export interface ServerDocumentOptions<T> {
    // Today's shape, or undefined for a file this version cannot read.
    readonly parse: (raw: StoredJson) => T | undefined;
    readonly fallback: () => T;
    // Append-only: a conversion is never edited or removed once shipped, only followed by another.
    readonly history?: readonly Conversion[];
    // Where the conversions apply: the document, each entry of a top-level array, or each value of an object keyed by id.
    readonly granularity?: Granularity;
}

// How a backend is doing, by its own account (`ServerActivation.health`), shown on its row in the Extensions list.
// `starting`: activated, still getting ready. `degraded`: serving, but something it relies on is not (a connection
// down, a download that failed), which `detail` says. `failed`: not serving at all.
export type ExtensionHealthState = "ok" | "starting" | "degraded" | "failed";

export interface ExtensionHealth {
    readonly state: ExtensionHealthState;
    // One sentence for the owner, required in spirit for anything but `ok`: a state with no stated reason is an opinion.
    readonly detail?: string;
}

// What `activateServer` may hand back: the two things only the extension can do for itself.
export interface ServerActivation {
    // Release what activation opened (listeners, timers, child processes, connections), before the host replaces this
    // extension's code or stops. With one, a change that touches only this extension (a rebuild, an update, a toggle)
    // reloads it alone and leaves every other backend running; without one, the whole host restarts. Bounded by the
    // host's deadline, after which the code is replaced anyway.
    readonly deactivate?: () => void | Promise<void>;
    // Asked on the host's health sweep and answered within its deadline; one that throws or does not answer in time
    // reads as `degraded`. Absent: the backend reads as `ok` while its activation stands.
    readonly health?: () => ExtensionHealth | Promise<ExtensionHealth>;
}

export interface ExtensionServerApi {
    // The host's @intentic/extension-api version, checked against `engines.intentic`.
    readonly apiVersion: string;
    // Absolute workspace root; the backend reads and writes it directly via node's `fs`, no file service in between.
    readonly workspaceRoot: string;
    // This extension's own checkout (absolute), where its bundled assets sit.
    readonly extensionDir: string;
    // This extension's own state directory (absolute), created before activation and keyed by `publisher.name`, so it
    // survives an update, a re-install and dev mode alike. Never versioned, never backed up, not carried to another
    // sandbox: resume marks, cached tokens, a listener's last port. Removing the extension deletes it.
    readonly stateDir: string;
    // This extension's own cache directory (absolute): what can be fetched or built again (a downloaded engine, an
    // index). Created before activation, ignored by the workspace watcher, deleted with the extension.
    readonly cacheDir: string;
    // A line in the daemon's log, attributed to this extension.
    readonly log: (message: string) => void;
    // A JSON file of the extension's own under `stateDir` (`path` is relative to it), evolved by its conversions.
    readonly document: <T>(path: string, options: ServerDocumentOptions<T>) => ServerDocument<T>;
    // The extension's own settings (`contributes.settings`), secret values included, as the owner set them now. Reached
    // without declaring anything in `permissions.daemon`: the daemon answers only about the extension asking.
    readonly settings: {
        get(): Promise<ExtensionSettingValues>;
        // Fires with the keys whose value changed, however they changed: the Extensions tab, an agent, a hand edit.
        onDidChange(listener: (keys: readonly string[]) => void): Disposable;
    };
    // Changes in the workspace as the daemon sees them, over one stream the host opens on the first listener and closes
    // with the last. The browser half's `onDidChangeFiles` is narrowed to the extension's own `contributes.files`; this
    // one is every change, since a backend reads the whole workspace anyway.
    readonly workspace: {
        // Workspace-relative paths written, created or deleted, in batches; an empty batch is a write the watcher
        // could not name (a build under a pruned directory), which a reader treats as "anything may have changed".
        onDidChangeFiles(listener: (paths: readonly string[]) => void): Disposable;
        // Repositories whose refs moved: a commit, a checkout, a branch or tag, a rebase.
        onDidChangeRefs(listener: (repos: readonly string[]) => void): Disposable;
        // The repository set itself moved (a clone, a scaffold, a delete); answers the whole set.
        onDidChangeRepos(listener: (repos: readonly string[]) => void): Disposable;
    };
    readonly routes: {
        // Serves this extension's route namespace; the daemon proxies /x/<id>/* here through its ordinary auth. A
        // second mount replaces the first.
        mount(handler: BackendRouteHandler): void;
    };
    // The agent's tools (`contributes.tools`). The host owns the MCP transport, its deadlines and the card lookup: it
    // answers the handshake, lists what `tools` returns for the card a server was mounted for (undefined for an
    // extension-level server), and runs a call with its arguments. `tools` runs per request, so what it returns may
    // follow the card's switches. A second serve replaces the first.
    readonly tools: {
        serve(tools: (card: ToolCard | undefined) => readonly ToolDefinition[] | Promise<readonly ToolDefinition[]>): void;
    };
    // Authenticated transport to the daemon's own routes; every call is checked against the manifest's
    // `permissions.daemon` allowlist.
    readonly daemon: {
        // The daemon's contract, typed: a call names a procedure and its answer arrives parsed by the procedure's output
        // schema. Refused before anything is sent unless `permissions.daemon` covers the method and path it resolves to.
        readonly rpc: ContractRouterClient<typeof sandboxContract>;
        // For what the contract does not carry: bytes (`/workspace/raw`) and the daemon's hand-written routes.
        request(path: string, init?: RequestInit): Promise<Response>;
        json<T>(path: string, init?: RequestInit): Promise<T>;
    };
}

export interface ExtensionServerContext {
    // This extension's routing id, its /x/<id> namespace segment.
    readonly extensionId: string;
}

// What a declared process (`contributes.processes`) gets, from `connectExtensionProcess` in
// `@intentic/extension-api/runtime`: the backend's api without the two halves only the backend host can serve. A
// process answers on its own port, so it mounts no routes and serves tools there (`contributes.tools.process`).
export type ExtensionProcessApi = Omit<ExtensionServerApi, "routes" | "tools">;

// Shape of the manifest `server` bundle's default (or named) export; `activateServer` runs once per activation, which
// is once per backend-host start unless the extension returns a `deactivate`, after which a change to it alone
// activates it again in place.
export interface ExtensionServerModule {
    activateServer(api: ExtensionServerApi, context: ExtensionServerContext): void | ServerActivation | Promise<void | ServerActivation>;
}
