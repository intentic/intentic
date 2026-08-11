/* The environment a spawned engine gets — PURE assembly, so what the extension asks of the engine is a fact a
 * test can pin rather than a side effect of spawning. Mirrors the engine's own local contract
 * (_sandbox/sandbox: platform/profile.ts): local profile, loopback only, no platform, no tokens.
 *
 * The paths keep the promise the local profile makes: nothing lands in the user's folder beyond the engine's
 * own workspace state dir, and nothing touches their home — history (worktrees, snapshots, logs) and the
 * provider-credential store live under the extension's storage. Credentials are deliberately SHARED across
 * workspaces (one auth dir): connecting Claude once is connecting it for every project, which is how every
 * other editor AI behaves and what a person expects of "their account". */
export interface EngineEnvParams {
    // The folder the engine serves — the workspace folder this window has open.
    readonly workspaceRoot: string;
    // The extension's own storage root (globalStorage): per-workspace history nests under it, auth is shared.
    readonly storageRoot: string;
    // A stable slug for this workspace folder (the caller hashes the path — hashing is not this module's job).
    readonly workspaceSlug: string;
    readonly port: number;
    // The origin family the host's webviews present, for the engine's CORS allowlist (may carry one `*`).
    readonly webviewOrigins: readonly string[];
}

export const engineEnv = ({ workspaceRoot, storageRoot, workspaceSlug, port, webviewOrigins }: EngineEnvParams): Record<string, string> => ({
    SANDBOX_PROFILE: "local",
    WORKSPACE_ROOT: workspaceRoot,
    HISTORY_ROOT: `${storageRoot}/workspaces/${workspaceSlug}/history`,
    AGENT_AUTH_DIR: `${storageRoot}/auth`,
    SANDBOX_PORT: String(port),
    SANDBOX_HOST: "127.0.0.1",
    WEB_ORIGIN: webviewOrigins.join(","),
    // The local floor (the engine refuses to serve otherwise) — spelled out so an inherited shell variable
    // can never silently re-platform a local engine.
    CONNECT_TOKEN: "",
    SANDBOX_PUBLIC_URL: "",
    PLATFORM_URL: "",
    GOOGLE_CLIENT_ID: "",
    SYNC_PAIR_TOKEN: "",
    HOST_PAIR_TOKEN: "",
    TRANSLATOR_URL: "",
});
