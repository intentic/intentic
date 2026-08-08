/* The contract between the daemon's backend supervisor and the backend host process it spawns — one JSON
 * value, passed whole in the child's environment. Env rather than argv because it carries the minted tokens
 * (argv is world-readable on /proc), and one value rather than many vars because the two sides must agree on
 * exactly one shape and a single JSON.parse is the cheapest way to make disagreement loud. */

export const BACKEND_CONFIG_ENV = "INTENTIC_BACKEND_CONFIG";

// The header the daemon presents on every request it proxies into the host. The host refuses anything else:
// its port is loopback-only, but loopback is shared with every process in the container, and route auth
// (owner, member floors) lives in the DAEMON's gate — so the host must only ever answer the daemon.
export const BACKEND_HOST_HEADER = "x-intentic-backend";

// The header a backend's daemon client presents its minted per-extension token in — verified by the daemon's
// extension grant against the manifest's `permissions.daemon` (auth/grants.ts).
export const EXTENSION_TOKEN_HEADER = "x-intentic-extension";

export interface BackendHostExtension {
    // The routing handle — the /x/<id> namespace segment (ExtensionSummary.id).
    readonly id: string;
    // The checkout root (absolute) and the manifest's checkout-relative server bundle path.
    readonly dir: string;
    readonly server: string;
    // The minted token this extension's api.daemon presents; scoped by the daemon to permissions.daemon.
    readonly daemonToken: string;
}

export interface BackendHostConfig {
    // Loopback port the host serves on — assigned by the supervisor, which is also what proxies to it.
    readonly port: number;
    readonly hostToken: string;
    // The daemon's own loopback origin, for api.daemon.
    readonly daemonUrl: string;
    readonly workspaceRoot: string;
    // The host's @intentic/extension-api version, reported as api.apiVersion.
    readonly apiVersion: string;
    readonly extensions: readonly BackendHostExtension[];
}

// One extension's activation outcome, reported on the host's /health and folded into GET /extensions rows.
export interface BackendExtensionStatus {
    readonly id: string;
    readonly state: "running" | "error";
    readonly detail?: string;
}

export interface BackendHealth {
    readonly ok: true;
    readonly extensions: readonly BackendExtensionStatus[];
}
