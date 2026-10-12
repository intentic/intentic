import { errorMessage } from "@intentic/base/errors";
import type { CliConfig } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { directExec, type ExecInTerminal } from "../../terminal/terminal-run.js";
import type { CapabilitiesStore } from "../capabilities-store.js";
import type { SshKeyStore } from "../ssh-key-store.js";
import { type GitAccessLog, gitAccessHook } from "./git-access.js";
import { npmAccessHook } from "./npm-access.js";

// Restrict connector hooks to providers with daemon-owned implementations. `keys` is where a hook keeps an SSH private
// key it makes (git access's account key), never a file the agent reads. `log`, where given, receives a line for each
// credential the hook stores, replaces or removes (never the credential itself).
export interface ConnectorHook {
    readonly apply: (config: CliConfig, exec: ExecInTerminal, keys: SshKeyStore, log?: ConnectorLog) => Promise<string | undefined>;
    readonly remove: (config: CliConfig, exec: ExecInTerminal, keys: SshKeyStore, log?: ConnectorLog) => Promise<void>;
    // What a recreated container must get back at boot; the connection survives on /work, the effect does not.
    readonly restore: (config: CliConfig, exec: ExecInTerminal, keys: SshKeyStore, log?: ConnectorLog) => Promise<string | undefined>;
    // Hook with no visible commands (secret-bearing fs writes only); skipped from the job session's terminal.
    readonly silent?: true;
}

export type ConnectorLog = GitAccessLog;

/** A hook's audit trail written to a daemon logger, at the level each line asks for; none without a logger. */
export const connectorLog = (logger: Pick<Logger, "info" | "warn"> | undefined): ConnectorLog | undefined =>
    logger === undefined ? undefined : (fields, message, level = "info") => logger[level](fields, message);

export const CORE_CONNECTOR_HOOKS: Record<string, ConnectorHook> = { github: gitAccessHook, gitlab: gitAccessHook, npm: npmAccessHook };

// Boot restore over the manifest, the connector counterpart to reconnectVpns: side effects die with the container.
// Best-effort per entry: a failure degrades one connection, never the daemon; status reports it, not a boot log.
export const restoreConnectorHooks = async (
    capabilities: CapabilitiesStore,
    keys: SshKeyStore,
    logger: { warn: (message: string) => void } | Pick<Logger, "info" | "warn">,
): Promise<void> => {
    // A daemon logger also takes the hooks' audit lines; a bare warn sink (a test's) takes only the warnings.
    const log = "info" in logger ? connectorLog(logger) : undefined;
    for (const capability of await capabilities.list()) {
        if (capability.kind !== "cli") {
            continue;
        }
        const hook = CORE_CONNECTOR_HOOKS[capability.config.provider];
        if (hook === undefined) {
            continue;
        }
        try {
            const warning = await hook.restore(capability.config, directExec, keys, log);
            if (warning !== undefined) {
                logger.warn(`connector ${capability.id}: ${warning}`);
            }
        } catch (error) {
            logger.warn(`connector ${capability.id}: could not restore: ${errorMessage(error)}`);
        }
    }
};
