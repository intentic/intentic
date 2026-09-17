// What the backend answers, shared by both halves so the card and the server agree on every state.

// The route namespace the daemon proxies to this extension's backend.
export const NAMESPACE = "/x/intentic.onlyoffice";

// Where the document server stands between the reader and the editor. `ready` means an editor session can be opened.
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
}

// `url` is the editor page to frame; `status` is why there is none yet.
export type OpenResult = { readonly url: string } | { readonly status: DocsState };
