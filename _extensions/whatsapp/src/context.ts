import type { DaemonClient } from "./daemon.js";
import type { Logger } from "./log.js";

// What the listener needs from the process: the daemon client (its only channel to automations) and a logger.
export interface GatewayCtx {
    readonly daemon: DaemonClient;
    readonly log: Logger;
}
