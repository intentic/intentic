import { RUNNER_PAIR_TOKEN_ENV, RUNNER_PARENT_URL_ENV } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { parentCredentialSource } from "./runner-credentials.js";
import { ensureRunnerIdentity, readRunnerIdentity } from "./runner-identity.js";
import { startRunnerLink } from "./runner-link.js";

/* RUNNER MODE, the boot-side switch (docs/remote-runners-plan.md at the workspace root): the same image,
 * told at container creation that it is a PARENT sandbox's execution container rather than a person's.
 *
 * Runner mode is a POSTURE, not a fork: the daemon boots exactly as any loopback sandbox does (no tunnel
 * env, no Google client, no connect token — a runner container simply is not given them, and the auth floor
 * in main.ts holds because it is unreachable), and after the boot chain converges this module adds the one
 * thing a runner has that a sandbox does not: the outbound link to its parent (runner-link.ts). Keeping the
 * whole daemon is the design's central trade — a dispatched turn runs through streamAgent, tmux, deps and
 * isolation exactly as a local one, because it is the same code. */

// What a runner container's env says, read once at boot. Both or neither: one without the other is a
// misassembled container worth refusing loudly rather than guessing about.
export interface RunnerModeEnv {
    readonly parentUrl: string;
    readonly pairToken: string;
}

export const runnerModeRequested = (env: NodeJS.ProcessEnv): RunnerModeEnv | undefined => {
    const parentUrl = env[RUNNER_PARENT_URL_ENV]?.trim() ?? "";
    const pairToken = env[RUNNER_PAIR_TOKEN_ENV]?.trim() ?? "";
    if (parentUrl === "" && pairToken === "") {
        return undefined;
    }
    if (parentUrl === "" || pairToken === "") {
        throw new Error(`runner mode needs both ${RUNNER_PARENT_URL_ENV} and ${RUNNER_PAIR_TOKEN_ENV}; got one without the other`);
    }
    return { parentUrl, pairToken };
};

/* Bring the runner online: redeem the pairing if this container never has (first boot; every later one reads
 * the identity off /history), then hold the parent link for the daemon's lifetime. Called after the boot
 * chain converges, because the first thing a parent does with a live link is dispatch work at machinery the
 * boot builds. A failed enrollment is fatal-by-log rather than fatal-by-exit: the reason lands in `docker
 * logs` once, instead of a crash loop re-spending nothing against an already-burned pairing. */
export const startRunnerMode = async (services: Services, env: RunnerModeEnv | undefined): Promise<void> => {
    // A container whose env was stripped on rebuild still has its identity; a container with neither is not
    // a runner and this is a no-op, which is every ordinary sandbox's boot.
    const identity = env !== undefined ? await ensureRunnerIdentity(services.config.historyRoot, env) : await readRunnerIdentity(services.config.historyRoot);
    if (identity === undefined) {
        return;
    }
    // Before the link, so the very first dispatched turn already resolves against the origin's providers.
    services.runnerParent.current = parentCredentialSource(identity, services.logger);
    startRunnerLink(services, identity);
};
