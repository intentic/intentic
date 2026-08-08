/* THE SERVER HALF an extension programs against — the daemon-side twin of IntenticApi (api.ts).
 *
 * A manifest `server` bundle exports `activateServer(api, context)`, and the daemon's BACKEND HOST — one
 * separate supervised node process shared by every enabled extension with a backend — imports the bundle and
 * calls it. A separate process rather than the daemon itself because loaded code can never be unloaded: the
 * off switch, an upgrade to a new sha and a live-edited workspace extension all require the process holding
 * the old code to die, and that process must never be the daemon (chat, terminals and file sync live there).
 * A shared process rather than one per extension because the trust model is full trust (install is owner-only
 * and sha-pinned) — isolation between extensions would buy robustness nobody is billed for.
 *
 * Full trust is also why this surface is deliberately small. The backend runs in the sandbox container as the
 * same user the daemon does, so the workspace is reachable with plain `node:fs` — the api hands over PATHS,
 * not a file service. What it does mediate is the two things a path cannot carry: the extension's route
 * namespace (mount), and its reach into the daemon's own routes (daemon.*, gated by the manifest's
 * `permissions.daemon` — the daemon refuses undeclared routes, same grammar and same honesty rule as the UI
 * half's `permissions.sandbox`). */

// One request into this extension's namespace. The host strips the `/x/<id>` prefix before dispatch, so the
// handler sees the extension's OWN paths — the same paths its contract declares and its UI half calls.
// `undefined` means "not mine": the host answers 404 without the extension having to speak HTTP for it.
export type BackendRouteHandler = (request: Request) => Promise<Response | undefined>;

export interface ExtensionServerApi {
    // The host's @intentic/extension-api version — what `engines.intentic` was checked against.
    readonly apiVersion: string;
    // The workspace root (absolute). The backend reads and writes under it with node's own fs — full trust
    // means no file service in between. Durable state belongs in workspace files (the same rule the UI half
    // lives by): it survives restarts, is shared across browsers, and the agent editing it out-of-band is the
    // product.
    readonly workspaceRoot: string;
    // This extension's own checkout (absolute) — where its bundled assets sit.
    readonly extensionDir: string;
    // A line in the daemon's log, attributed to this extension.
    readonly log: (message: string) => void;
    readonly routes: {
        /* Serve this extension's route namespace. The daemon proxies /x/<id>/* here — through its ordinary
         * auth (an owner's browser, a member at the route's role floor), so a backend never sees an
         * unauthenticated request and never sees a credential. One handler per extension: the extension owns
         * its whole namespace, and how it routes inside it (an oRPC handler over its own contract, a plain
         * switch) is its own business. A second mount replaces the first. */
        mount(handler: BackendRouteHandler): void;
    };
    /* The authenticated transport to the daemon's own routes — the backend's `api.sandbox`. Auth is a minted
     * per-extension token injected here; the daemon's gate checks every call against the manifest's
     * `permissions.daemon` allowlist, so a backend's reach into the core is declared, reviewable and refusable
     * exactly like the UI half's. The extension's own namespace needs no declaration — but there is also no
     * reason to dial yourself over HTTP. */
    readonly daemon: {
        request(path: string, init?: RequestInit): Promise<Response>;
        json<T>(path: string, init?: RequestInit): Promise<T>;
    };
}

export interface ExtensionServerContext {
    // The extension's routing id — its /x/<id> namespace segment (the capability entry id for a git-installed
    // extension, publisher.name otherwise; the same id the UI half sees as ExtensionSummary.id).
    readonly extensionId: string;
}

// The shape of the manifest `server` bundle's default export (or its named exports): `activateServer` runs
// once per backend-host start, after the engines check. There is no deactivate — retirement IS the host
// process ending, which is the one teardown that cannot leak.
export interface ExtensionServerModule {
    activateServer(api: ExtensionServerApi, context: ExtensionServerContext): void | Promise<void>;
}
