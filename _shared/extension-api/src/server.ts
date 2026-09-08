// Backend counterpart to `IntenticApi` (api.ts); a manifest `server` bundle's `activateServer` runs in a node process
// shared by every enabled extension, separate from the daemon. Mediates only the extension's route namespace (mount)
// and its reach into daemon routes (`daemon.*`, gated by `permissions.daemon`).

// One request into this extension's `/x/<id>` namespace, prefix already stripped. Return `undefined` for "not mine":
// the host answers 404.
export type BackendRouteHandler = (request: Request) => Promise<Response | undefined>;

export interface ExtensionServerApi {
    // The host's @intentic/extension-api version, checked against `engines.intentic`.
    readonly apiVersion: string;
    // Absolute workspace root; the backend reads and writes it directly via node's `fs`, no file service in between.
    readonly workspaceRoot: string;
    // This extension's own checkout (absolute), where its bundled assets sit.
    readonly extensionDir: string;
    // A line in the daemon's log, attributed to this extension.
    readonly log: (message: string) => void;
    readonly routes: {
        // Serves this extension's route namespace; the daemon proxies /x/<id>/* here through its ordinary auth. A
        // second mount replaces the first.
        mount(handler: BackendRouteHandler): void;
    };
    // Authenticated transport to the daemon's own routes; every call is checked against the manifest's
    // `permissions.daemon` allowlist.
    readonly daemon: {
        request(path: string, init?: RequestInit): Promise<Response>;
        json<T>(path: string, init?: RequestInit): Promise<T>;
    };
}

export interface ExtensionServerContext {
    // This extension's routing id, its /x/<id> namespace segment.
    readonly extensionId: string;
}

// Shape of the manifest `server` bundle's default (or named) export; `activateServer` runs once per backend-host start.
// No deactivate: retirement is the host process ending.
export interface ExtensionServerModule {
    activateServer(api: ExtensionServerApi, context: ExtensionServerContext): void | Promise<void>;
}
