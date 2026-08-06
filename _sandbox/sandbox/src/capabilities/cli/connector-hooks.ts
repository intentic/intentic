import type { CliConfig } from "@intentic/sandbox-contract";
import { directExec, type ExecInTerminal } from "../../terminal/terminal-run.js";
import type { CapabilitiesStore } from "../capabilities-store.js";
import { gitAccessHook } from "./git-access.js";
import { npmAccessHook } from "./npm-access.js";

// A connector's privileged side effect beyond env + skill, run by cliHandler around the skill write/remove.
// This CANNOT be data (it shells out with the host's credentials, registers account keys, writes credential
// files), so it stays core, keyed by PROVIDER NAME — a connector extension declares the name, the daemon owns
// what that name is allowed to do. Only the git providers and npm have one; every other connector is pure data.
export interface ConnectorHook {
    readonly apply: (config: CliConfig, exec: ExecInTerminal) => Promise<string | undefined>;
    readonly remove: (config: CliConfig, exec: ExecInTerminal) => Promise<void>;
    // What a recreated container has to get back at boot — the connection survives on /work, its side effect on
    // the container's own filesystem does not.
    readonly restore: (config: CliConfig, exec: ExecInTerminal) => Promise<string | undefined>;
    // A hook that runs no visible commands (its writes are secret-bearing fs calls). cliHandler then skips
    // surfacing the job session, which would otherwise open an empty terminal over a silent apply.
    readonly silent?: true;
}

export const CORE_CONNECTOR_HOOKS: Record<string, ConnectorHook> = { github: gitAccessHook, gitlab: gitAccessHook, npm: npmAccessHook };

// main.ts's boot restore over the manifest — the connector counterpart to reconnectVpns: a hook's container-
// local side effect (git credentials, the ~/.npmrc auth line) dies with the container while the connection
// survives on /work, so every connected provider gets it back before the first turn (or the owner's first
// `git pull` / `npm publish`) needs it. Best-effort per entry, and silent when it works: a failure here degrades
// one connection, never the daemon, and the capability's own status reports the result rather than a boot log
// nobody reads.
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
            logger.warn(`connector ${capability.id}: could not restore: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
};
