import type { DaemonClient } from "./daemon.js";
import type { Logger } from "./log.js";

// What the connection module needs from the process: the daemon client (its only channel to automations), the
// workspace root (the per-account UID watermark persists under it), and a logger.
export interface GatewayCtx {
    readonly daemon: DaemonClient;
    readonly workspaceRoot: string;
    readonly log: Logger;
}
