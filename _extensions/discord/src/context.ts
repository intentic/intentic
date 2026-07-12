import type { DaemonClient } from "./daemon.js";
import type { Logger } from "./log.js";

// What the listener + voice modules need from the process: the daemon client (their only channel to automations),
// the workspace root (transcripts + the whisper model live under it, so the agent can read them), and a logger.
export interface GatewayCtx {
    readonly daemon: DaemonClient;
    readonly workspaceRoot: string;
    readonly log: Logger;
}
