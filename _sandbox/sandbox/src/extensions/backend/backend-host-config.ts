import type { ExtensionHealth } from "@intentic/extension-api";

// The daemon-to-backend-host contract: one JSON value passed via env, not argv (world-readable on /proc).

export const BACKEND_CONFIG_ENV = "INTENTIC_BACKEND_CONFIG";

// Marks a request as daemon-proxied; the host rejects all else, loopback is shared in the container.
export const BACKEND_HOST_HEADER = "x-intentic-backend";

// Carries the card a door request is for, `{ id, config }` as base64url JSON: the settings the daemon resolved (secrets
// included), so an endpoint serving a card's tools need not read them back. Only the daemon's MCP door sets it; every
// other way in has it stripped.
export const BACKEND_CARD_HEADER = "x-intentic-card";

export interface BackendHostExtension {
    // Routing handle: the /x/<id> namespace segment (ExtensionSummary.id).
    readonly id: string;
    // `dir` is the absolute checkout root; `server` is its checkout-relative server bundle path.
    readonly dir: string;
    readonly server: string;
    // The bundle's content digest: what tells a reload which extensions changed, and the query that makes Node import the
    // new code rather than the module it already cached under the same path.
    readonly bundle: string;
    // Its own directories (extensions/runtime/extension-state.ts), created before the host is told about them.
    readonly stateDir: string;
    readonly cacheDir: string;
    // Minted token api.daemon presents; scoped by the daemon to permissions.daemon.
    readonly daemonToken: string;
    // The manifest's permissions.daemon, the same list the token is scoped to: api.daemon.rpc refuses outside it before
    // sending, while the daemon's grant stays what enforces it.
    readonly daemonPermissions: readonly string[];
}

export interface BackendDeviceConfig {
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
    // Whether a change to it alone can be made in place (its activation handed back a `deactivate`); otherwise only a
    // restart of the whole host replaces its code.
    readonly reloadable?: boolean;
    // Its own account of itself (`ServerActivation.health`), as of the supervisor's last sweep; absent while it has said
    // nothing but `ok`, and before the first sweep reads it.
    readonly health?: ExtensionHealth;
}

export interface BackendHealth {
    readonly ok: true;
    readonly extensions: readonly BackendExtensionStatus[];
}

// The host's in-place reload: the whole set it should run now. It answers the new statuses, or 409 when an extension
// that would change cannot be let go of in place, which the supervisor answers with a restart.
export interface BackendReload {
    readonly extensions: readonly BackendHostExtension[];
}
