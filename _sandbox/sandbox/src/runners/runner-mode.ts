import { RUNNER_PAIR_TOKEN_ENV, RUNNER_PARENT_URL_ENV } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { parentCredentialSource } from "./runner-credentials.js";
import { ensureRunnerIdentity, readRunnerIdentity } from "./runner-identity.js";
import { startRunnerLink } from "./runner-link.js";

// The same image, told at container creation that it's a parent's execution container, not a person's. A posture, not a
// fork: the daemon boots as any loopback sandbox, then adds the one thing a runner has, an outbound link to its parent.
// A dispatched turn still runs through streamAgent, tmux, deps and isolation exactly as a local one.

// Both env vars or neither; one without the other is a misassembled container, refused loudly rather than guessed at.
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

// Redeems the pairing on first boot (later boots read identity off /history), then holds the parent link for the
// daemon's life. A failed enrollment is fatal-by-log, not fatal-by-exit: no crash loop against an already-burned
// pairing.
export const startRunnerMode = async (services: Services, env: RunnerModeEnv | undefined): Promise<void> => {
    // A stripped env still has its stored identity; neither present means an ordinary sandbox boot, a no-op.
    const identity = env !== undefined ? await ensureRunnerIdentity(services.config.historyRoot, env) : await readRunnerIdentity(services.config.historyRoot);
    if (identity === undefined) {
        return;
    }
    // Before the link, so the very first dispatched turn already resolves against the origin's providers.
    services.runnerParent.current = parentCredentialSource(identity, services.logger);
    startRunnerLink(services, identity);
};
