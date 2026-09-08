import { errorMessage } from "@intentic/base/errors";
import type { CliConfig } from "@intentic/sandbox-contract";
import { directExec, type ExecInTerminal } from "../../terminal/terminal-run.js";
import type { CapabilitiesStore } from "../capabilities-store.js";
import { gitAccessHook } from "./git-access.js";
import { npmAccessHook } from "./npm-access.js";

// A connector's side effect beyond env+skill, run by cliHandler; can't be data, it shells with host credentials.
// Keyed by provider name (the extension declares it, the daemon owns what it may do); only git providers and npm have
// one.
export interface ConnectorHook {
    readonly apply: (config: CliConfig, exec: ExecInTerminal) => Promise<string | undefined>;
    readonly remove: (config: CliConfig, exec: ExecInTerminal) => Promise<void>;
    // What a recreated container must get back at boot; the connection survives on /work, the effect does not.
    readonly restore: (config: CliConfig, exec: ExecInTerminal) => Promise<string | undefined>;
    // Hook with no visible commands (secret-bearing fs writes only); skipped from the job session's terminal.
    readonly silent?: true;
}

export const CORE_CONNECTOR_HOOKS: Record<string, ConnectorHook> = { github: gitAccessHook, gitlab: gitAccessHook, npm: npmAccessHook };

// Boot restore over the manifest, the connector counterpart to reconnectVpns: side effects die with the container.
// Best-effort per entry: a failure degrades one connection, never the daemon; status reports it, not a boot log.
export const restoreConnectorHooks = async (capabilities: CapabilitiesStore, logger: { warn: (message: string) => void }): Promise<void> => {
    for (const capability of await capabilities.list()) {
        if (capability.kind !== "cli") {
            continue;
        }
        const hook = CORE_CONNECTOR_HOOKS[capability.config.provider];
        if (hook === undefined) {
            continue;
        }
        try {
            const warning = await hook.restore(capability.config, directExec);
            if (warning !== undefined) {
                logger.warn(`connector ${capability.id}: ${warning}`);
            }
        } catch (error) {
            logger.warn(`connector ${capability.id}: could not restore: ${errorMessage(error)}`);
        }
    }
};
