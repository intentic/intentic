// The daemon-to-backend-host contract: one JSON value passed via env, not argv (world-readable on /proc).

export const BACKEND_CONFIG_ENV = "INTENTIC_BACKEND_CONFIG";

// Marks a request as daemon-proxied; the host rejects all else, loopback is shared in the container.
export const BACKEND_HOST_HEADER = "x-intentic-backend";

// Header carrying an extension's minted token, checked against permissions.daemon (auth/grants.ts).
export const EXTENSION_TOKEN_HEADER = "x-intentic-extension";

export interface BackendHostExtension {
    // Routing handle: the /x/<id> namespace segment (ExtensionSummary.id).
    readonly id: string;
    // `dir` is the absolute checkout root; `server` is its checkout-relative server bundle path.
    readonly dir: string;
    readonly server: string;
    // Minted token api.daemon presents; scoped by the daemon to permissions.daemon.
    readonly daemonToken: string;
}

export interface BackendHostConfig {
    // Loopback port the host serves on, assigned by the supervisor, which also proxies to it.
    readonly port: number;
    readonly hostToken: string;
    // Daemon's own loopback origin, used for api.daemon.
    readonly daemonUrl: string;
    readonly workspaceRoot: string;
    // Host's @intentic/extension-api version, reported as api.apiVersion.
    readonly apiVersion: string;
    readonly extensions: readonly BackendHostExtension[];
}

// One extension's activation outcome; reported on the host's /health and folded into GET /extensions rows.
export interface BackendExtensionStatus {
    readonly id: string;
    readonly state: "running" | "error";
    readonly detail?: string;
}

export interface BackendHealth {
    readonly ok: true;
    readonly extensions: readonly BackendExtensionStatus[];
}
