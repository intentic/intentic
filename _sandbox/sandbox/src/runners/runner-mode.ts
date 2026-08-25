import { RUNNER_PAIR_TOKEN_ENV, RUNNER_PARENT_URL_ENV, runnerConnectUrl } from "@intentic/sandbox-contract";

/* RUNNER MODE, the boot-side switch (docs/remote-runners-plan.md, workspace root): the same image, told at
 * container creation that it is a PARENT sandbox's execution container rather than a person's. Runner mode
 * subtracts, no owner bind, no tunnel, no capability surface, and keeps the turn machinery, which is the
 * whole reason a runner is a daemon and not a bare agent CLI.
 *
 * Phase-1 skeleton: detection is real (main.ts consults it before anything else, `ic runner up` and the Fly
 * provisioner already know what env to write), starting is an honest refusal. Honest beats partial here: a
 * daemon that booted "most of" runner mode would bind an owner, open a tunnel and serve a browser surface,
 * every one of which is exactly what a runner must not do. */

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

/* Phase 1 proper: redeem the pairing over /system/runners/enroll, dial runnerConnectUrl(parentUrl), send the
 * hello, then SERVE runnerContract over the socket (the @intentic/host agent's inversion: this side dialled,
 * this side is the oRPC server) with the reconnect backoff that agent already models. Until then, the boot
 * stops here, before an owner bind or tunnel could exist. */
export const startRunnerMode = (env: RunnerModeEnv): never => {
    throw new Error(
        `runner mode is designed but not implemented yet (docs/remote-runners-plan.md): ` +
            `this container would dial ${runnerConnectUrl(env.parentUrl)} and serve runnerContract`,
    );
};
