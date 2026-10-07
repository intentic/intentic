import type { ExtensionProcessApi } from "@intentic/extension-api/runtime";
import type { DaemonClient } from "./daemon.js";
import type { Logger } from "./log.js";

// What a connector's listener/connection modules need from the process: the daemon client (their only channel to
// automations), the process's own extension api (its state and cache directories, its settings, the workspace's events,
// the daemon's typed routes, the same api a `server` bundle is handed), the workspace root (discord's transcripts
// persist under it) and a logger. Built once by the gateway shell and handed to the connector's create() hook.
export interface GatewayCtx<TConfig extends { readonly provider: string } = { readonly provider: string }> {
    readonly api: ExtensionProcessApi;
    readonly daemon: DaemonClient<TConfig>;
    readonly workspaceRoot: string;
    readonly log: Logger;
}
