import { RUNNER_PAIR_TOKEN_ENV, RUNNER_PARENT_URL_ENV } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { Services } from "../composition.js";
import { parentCredentialSource } from "./runner-credentials.js";
import { ensureRunnerIdentity, readRunnerIdentity } from "./runner-identity.js";
import { startRunnerLink } from "./runner-link.js";
import type { RunnerCardStops } from "./live/runner-live-wiring.js";
import { parentUplink } from "./uplink/parent-uplink.js";
import { parentWake } from "./ownership/wake.js";
import { parentFleetRead } from "./fleet/parent-fleet.js";
import { parentSubagentCall } from "./fleet/parent-subagents.js";
import { seedRunnerPresentation } from "./naming/runner-presentation.js";
import { filePresentationStore } from "../system/presentation/presentation-store.js";

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
// `stops`: a person's stops on a card, the agent layer's, handed in by main.ts for the parent's card of a conversation here.
export const startRunnerMode = async (services: Services, env: RunnerModeEnv | undefined, working: () => number, stops?: RunnerCardStops): Promise<void> => {
    // A stripped env still has its stored identity; neither present means an ordinary sandbox boot, a no-op.
    const identity = env !== undefined ? await ensureRunnerIdentity(services.config.historyRoot, env) : await readRunnerIdentity(services.config.historyRoot);
    if (identity === undefined) {
        return;
    }
    // Named on its machine before the link is up: by its id and its parent's address until the parent says more
    // (runner-presentation.ts). Never fatal: a runner that cannot write it is still a runner, listed by its slug.
    await seedRunnerPresentation(filePresentationStore(services.config.historyRoot), identity).catch((err: Error) =>
        services.logger.warn({ err }, "runner: could not keep its name for its machine's listing"),
    );
    // Before the link, so the very first dispatched turn already resolves against the origin's providers.
    // And the owner of every conversation it runs: its own wakes go there (runners/ownership/wake.ts).
    // Its turns' fleet reads go there too: the parent holds every conversation's record (runners/fleet/parent-fleet.ts).
    services.runnerParent.current = {
        ...parentCredentialSource(identity, services.logger),
        wake: parentWake(identity, services.logger),
        fleet: parentFleetRead(identity),
        // And the subagents its turns supervise are the parent's: spawned, placed, supervised and landed there.
        subagents: parentSubagentCall(identity),
    };
    startRunnerLink(services, identity, working, undefined, stops);
    // The parent reaches this runner's netd only down the uplink netd dials with the runner's own token (netd's
    // parent.rs): its terminals, browser and desktop views and previews, for the parent's people (parent-uplink.ts).
    parentUplink.want(identity);
};
