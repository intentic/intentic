// What the backend answers, shared by both halves so the card and the server agree on every state.

// The route namespace the daemon proxies to this extension's backend.
export const NAMESPACE = "/x/intentic.onlyoffice";

// Which engine runs an editor. `browser`: ONLYOFFICE's offline build converting and editing in the reader's browser,
// from a bundle the sandbox downloads once and serves, with no Docker. `server`: ONLYOFFICE Docs in a container in the
// sandbox's Docker engine, which two tabs can co-edit through.
export type Engine = "browser" | "server";
export const ENGINES = ["browser", "server"] as const satisfies readonly Engine[];

// Where an engine stands between the reader and the editor. `ready` means an editor session can be opened. The browser
// engine uses `not-started`, `pulling` (its one download), `ready` and `error`; the rest are the container's.
export type DocsState =
    | { readonly state: "docker-off"; readonly detail: string }
    | { readonly state: "not-started" }
    | { readonly state: "pulling"; readonly percent: number | undefined }
    | { readonly state: "starting" }
    | { readonly state: "no-address" }
    | { readonly state: "ready" }
    | { readonly state: "error"; readonly detail: string };

export interface OpenRequest {
    readonly path: string;
    // A conversation's checkout to read the file from; absent for the shared tree. Always opened read-only.
    readonly agent?: string;
    readonly mode: "edit" | "view";
    readonly theme: "light" | "dark";
    // The owner's engine setting as the viewer read it; absent reads as the default, the browser engine.
    readonly engine?: Engine;
    // The app's language, for the editor's own interface ("en", "de", ...).
    readonly lang?: string;
    // The app's origin: the browser engine's editor page posts what it says to the viewer there and nowhere else.
    readonly origin?: string;
    // The session of an editor the viewer kept alive for this document. When it still holds what an open would get, the
    // answer is `resumed` and the viewer shows that editor again instead of loading a new one.
    readonly resume?: string;
}

// `url` is the editor page to frame, running under `session` on `engine`; `resumed` keeps the editor named by `resume`;
// `status` is why there is neither yet.
export type OpenResult =
    | { readonly url: string; readonly session: string; readonly engine: Engine }
    | { readonly resumed: true }
    | { readonly status: DocsState };

// Asks the document server to write a session's document to the workspace now: the viewer's call when it keeps an
// editor alive out of sight. Best effort, and a no-op for a document with nothing unsaved.
export interface ForceSaveRequest {
    readonly session: string;
}
