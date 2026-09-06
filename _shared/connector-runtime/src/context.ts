import type { DaemonClient } from "./daemon.js";
import type { Logger } from "./log.js";

// What a connector's listener/connection modules need from the process: the daemon client (their only channel
// to automations), the workspace root (discord's transcripts and imap's UID watermarks persist under it), and
// a logger. Built once by the gateway shell and handed to the connector's create() hook.
export interface GatewayCtx<TConfig extends { readonly provider: string } = { readonly provider: string }> {
    readonly daemon: DaemonClient<TConfig>;
    readonly workspaceRoot: string;
    readonly log: Logger;
}
