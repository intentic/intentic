import type { Logger } from "pino";
import type { Config } from "../env.config.js";
import { AGENT_SESSION_ENV, type ContainerRole } from "../system/boot/container-owner.js";
import type { ProfileTraits } from "../system/boot/profile.js";
import { statePath } from "../state-paths.js";
import type { DocumentSpec } from "../store/evolution/documents.js";
import { commitState, convergeState, type StateRoots } from "../store/evolution/state-convergence.js";
import type { StructuralStep } from "../store/evolution/state-steps.js";
import { version } from "../version.js";
import type { BootPhase } from "./boot-phase.js";

// The two moments of boot the state engine owns (store/evolution/state-convergence.ts): converging stored files to this build's
// shapes before any store opens, and committing that episode once the boot chain has converged, the point past which
// nothing it converted needs undoing.

// AI-provider credential root; AGENT_AUTH_DIR shares it across dev sandboxes so subscription OAuth survives.
export const authRootOf = (config: Pick<Config, "agentAuthDir" | "workspaceRoot">): string =>
    config.agentAuthDir !== "" ? config.agentAuthDir : statePath(config.workspaceRoot, ".intentic/secrets/auth/");

export const stateRootsOf = (config: Config): StateRoots => ({ workspace: config.workspaceRoot, history: config.historyRoot, auth: authRootOf(config) });

// Only the daemon that owns these volumes converts them: the container's claim holder, or a local daemon that is not
// a run of the code from inside an agent session. Everyone else learns the stamp and converts on read.
export const mayConverge = (traits: ProfileTraits, role: ContainerRole, env: NodeJS.ProcessEnv = process.env): boolean =>
    role.container || (!traits.convergeHome && role.roots && env[AGENT_SESSION_ENV] === undefined);

interface StateBoot {
    readonly config: Config;
    readonly logger: Logger;
    readonly traits: ProfileTraits;
    readonly role: ContainerRole;
    // Every document and step this build knows: main.ts hands in state-registry.ts, generated beside this module.
    readonly documents: readonly DocumentSpec[];
    readonly steps: readonly StructuralStep[];
}

// Never fatal: a failure here leaves every file as it was or journaled, and the stores still convert on read, which is
// strictly better than a daemon that cannot start (a hosted sandbox has no previous image to roll back to).
export const convergeStateAtBoot = async ({ config, logger, traits, role, documents, steps }: StateBoot): Promise<void> => {
    try {
        await convergeState({
            roots: stateRootsOf(config),
            documents,
            steps,
            version,
            logger,
            mayWrite: mayConverge(traits, role),
        });
    } catch (error) {
        logger.error({ err: error }, "state: converging this workspace's stored files failed; the stores convert on read instead");
    }
};

// A committed episode that changed files becomes a checkpoint on the workspace timeline, so the owner can see what the
// update converted and restore the one before it.
export const commitStateAtBoot = async ({ config, logger, services }: BootPhase): Promise<void> => {
    try {
        const episode = await commitState(stateRootsOf(config));
        if (episode !== undefined && episode.entries.length > 0) {
            await services.history.snapshot("user", `intentic ${version} converted ${episode.entries.length} stored files`);
        }
    } catch (error) {
        logger.warn({ err: error }, "state: the conversion journal could not be committed; the next boot finds it open");
    }
};
