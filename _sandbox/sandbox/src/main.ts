import { setRunnerEnv } from "@intentic/base/git";
import { DisposableStore } from "@intentic/base/lifecycle";
import { HISTORY_ROOT } from "@intentic/constants";
import { startRoomSocket } from "./workload/room-socket.js";
import { startWorkSignal } from "./workload/work-signal.js";
import { STARTER_APP, STARTER_REPO } from "@intentic/sandbox-contract";
import { startProviderBoot } from "./agent/providers/provider-registry.js";
import { declareBootSteps, runBootSteps } from "./bootstrap/boot-chain.js";
import { armSetupPairings } from "./bootstrap/boot-pairings.js";
import type { BootPhase } from "./bootstrap/boot-phase.js";
import { startBootRestores } from "./bootstrap/boot-restores.js";
import { startBootResumes } from "./bootstrap/boot-resumes.js";
import { startBootSchedulers } from "./bootstrap/boot-schedulers.js";
import { startBootSweeps } from "./bootstrap/boot-sweeps.js";
import { startChangeReactions } from "./bootstrap/change-reactions.js";
import { forgetDaemonOnlyEnv, prepareDaemonProcess, requireAuthWhenReachable } from "./bootstrap/daemon-env.js";
import { startDaemonMetrics } from "./bootstrap/daemon-metrics.js";
import { wireDependencyCoordinator } from "./bootstrap/deps-coordination.js";
import { requireNetdSockets, startNetdDoor } from "./bootstrap/netd-door.js";
import { startCredentialGateway } from "./capabilities/broker/broker-server.js";
import { startPlatformPresence } from "./bootstrap/platform-presence.js";
import { commitStateAtBoot, convergeStateAtBoot } from "./bootstrap/state-boot.js";
import { startVersionWatches } from "./bootstrap/version-watches.js";
import { startWorkspaceApps } from "./bootstrap/workspace-apps.js";
import { workingNow } from "./bootstrap/working-now.js";
import { createServices, servicesTeardown } from "./composition.js";
import { stateDocuments, stateSteps } from "./bootstrap/state-registry.js";
import { logsRoot } from "./logs/log-files.js";
import { CONTAINER_SECRET_ENV, loadConfig } from "./env.config.js";
import { sealConfigSecrets } from "./seams/sealed-env.js";
import { type BootAttempt, clearBootFailure, failBoot } from "./system/boot/boot-failure.js";
import { bootFacts } from "./system/boot/boot-history.js";
import { claimContainer } from "./system/boot/container-owner.js";
import { tearDown } from "./system/boot/daemon-stop.js";
import { type BootFault, bootFault, CRASH_AFTER_READY_MS } from "./system/boot/fault.js";
import { finishPrewarm } from "./system/boot/prewarm.js";
import { listenHost, profileTraits, requireLocalContract } from "./system/boot/profile.js";
import { requireProjectDir } from "./system/project-dir.js";
import { checks as containerChecks, owner as containerOwner } from "./system/invariant.js";
import { readCgroup } from "./system/resources/cgroup.js";
import { startBootProfile } from "./system/resources/loop/boot-profile.js";
import { startLoopWatchdog } from "./system/resources/loop/loop-watchdog.js";
import { answers } from "./ports/port-probe.js";
import { type RunnerModeEnv, runnerModeRequested, startRunnerMode } from "./runners/runner-mode.js";
import { appPanelKey } from "./workspace/layout/app-previews.js";

// Sandbox container's entrypoint; config comes from env injected at run time, never baked in. It settles the process,
// builds the services once, and then calls each phase of boot in the one order that is behavior: listeners come up
// immediately (`/health`, `/events`), data routes wait behind the readiness gate until the boot chain finishes, and
// everything past the gate is background machinery no queued request depends on. Each phase owns its own subject and
// registers its own teardown, so nothing here enumerates what to stop.
// A boot that fails before the gate opens records why and exits (system/boot/boot-failure.ts), rather than lingering
// as a daemon that answers /health and never serves: netd restarts it with backoff, and the host reads the record.
// Shutdown runs every registered stop newest first, so the doors that admit work close before the services behind
// them, and waits for the asynchronous ones only as long as system/boot/daemon-stop.ts allows.

// What the rest of the boot needs once the gate has opened.
interface Ready {
    readonly phase: BootPhase;
    readonly runnerEnv: RunnerModeEnv | undefined;
    readonly prewarm: boolean;
    // The one deliberate stop, registered on SIGTERM and SIGINT as soon as there is anything to tear down.
    readonly stop: (exitCode?: number) => void;
}

// Everything up to and including the gate opening. Throws whatever stops the boot short of it.
const bootToGate = async (attempt: BootAttempt, fault: BootFault | undefined): Promise<Ready> => {
    // Runner mode is validated before anything else builds: a misassembled runner (runner-mode.ts) crashes here with
    // the reason logged, rather than half-booting. A well-formed runner otherwise boots like any loopback sandbox.
    const runnerEnv = runnerModeRequested(process.env);
    const config = loadConfig();
    // Read, so out of the environment before anything is spawned: no child inherits a container secret (sealed-env.ts).
    sealConfigSecrets({ secretEnv: CONTAINER_SECRET_ENV, keys: config });
    attempt.historyRoot = config.historyRoot;
    requireAuthWhenReachable(config);
    requireLocalContract(config);
    requireProjectDir(config);
    const netdSockets = requireNetdSockets();
    // Profile differences below read a named trait, never the profile value directly (system/boot/profile.ts).
    const traits = profileTraits(config);
    const host = listenHost(config);
    const logger = prepareDaemonProcess(config, traits);
    attempt.logger = logger;
    if (fault !== undefined) {
        logger.warn({ fault }, "boot: INTENTIC_FAULT is set, so this run fails on purpose for the update drill");
    }

    // Every subsystem registers its own teardown at creation; nothing here enumerates what to stop.
    const shutdown = new DisposableStore();
    attempt.shutdown = shutdown;
    // Once, however many signals arrive: a second SIGTERM while the first teardown runs changes nothing. Keeps going
    // past a stop that throws or hangs and names it; the exit happens whatever the teardown did.
    let stopping: Promise<void> | undefined;
    const stop = (exitCode = 0): void => {
        stopping ??= (async () => {
            logger.info("shutting down intentic sandbox daemon…");
            const unstopped = await tearDown(shutdown);
            if (unstopped !== undefined) {
                logger.error({ detail: unstopped }, "shutdown: one or more subsystems did not stop cleanly");
            }
            // Fires the exit hook in daemon-env.ts, stamping the marker exited so the next boot reads a deliberate stop.
        })().finally(() => process.exit(exitCode));
    };
    // Registered while boot is still under way, not once it is over: a stop that arrives mid-boot (the host's, the
    // netd closing its socket, idle-stop) would otherwise take Node's default exit, tearing nothing down and leaving
    // the marker unstamped, so the next boot would report a kill nobody made.
    // Wrapped: a signal listener is called with the signal's name, which is no exit code.
    process.on("SIGTERM", () => stop());
    process.on("SIGINT", () => stop());
    // Stall detector: logs the lag and the machine's pressure numbers when the event loop freezes.
    const loopWatchdog = startLoopWatchdog(logger);
    shutdown.push(() => loopWatchdog.stop());
    // Names the function behind a boot stall, which the watchdog can only time: kept under logs/ when one happened.
    // Started ahead of the state convergence below, so an update's first boot is profiled too.
    const bootProfile = startBootProfile(logger, logsRoot(config.historyRoot));
    shutdown.push(() => bootProfile.stop());
    // Claims container ownership before anything container-wide runs, since a container can hold more than one daemon
    // (container-owner.ts). LOCAL never claims: it owns nothing container-wide, and its role is pinned, not derived.
    // Ahead of the services, since the claim holder alone converges the stored files below.
    attempt.stage = "Claiming the container";
    const role = traits.convergeHome
        ? await claimContainer({ workspaceRoot: config.workspaceRoot, historyRoot: config.historyRoot }, logger)
        : { container: false, roots: true };
    attempt.role = role;
    if (fault === "crash-at-boot") {
        throw new Error("INTENTIC_FAULT=crash-at-boot: this boot fails on purpose before it converges the stored files");
    }
    // Brings every stored file to this build's shapes before a single store opens (store/evolution/state-convergence.ts), under a
    // journal a rolled-back build undoes; committed once the boot chain converges, below. A conversion that fails is
    // put back and logged there, never thrown here: boot goes on converting on read.
    attempt.stage = "Converging the stored files";
    await convergeStateAtBoot({ config, logger, traits, role, documents: stateDocuments(), steps: stateSteps(), fault });
    attempt.stage = "Building the services";
    const services = createServices(config, logger);
    attempt.services = services;
    // What composing started on its own clock; registered first, so it stops last, after everything built on it.
    for (const teardown of servicesTeardown(services)) {
        shutdown.push(teardown);
    }
    // The budget's verdict for heavy commands and test fan-outs, on a socket of its own; one per container, so the
    // daemon that claimed the container serves it.
    if (role.container) {
        // The daemon's own git signs through the owner's ssh agent socket (bound below): an alias names only the public half
        // of its key (ssh-hosts.ts), so a fetch or pull without SSH_AUTH_SOCK fails "Permission denied (publickey)". Handed
        // to the git runner, not set on process.env, which every other child (an extension backend, a turn bound no socket
        // of its own) would inherit. Only where the agent is the container's, as for the tmux server (boot-sweeps.ts).
        setRunnerEnv({ SSH_AUTH_SOCK: services.sshAgent.owner });
        const room = await startRoomSocket(services.resources, logger, undefined, services.perf);
        shutdown.push(() => room.close());
        // How much a restart would cut, for the host's keeper, which then asks before it restarts this sandbox (work-signal.ts).
        const work = startWorkSignal({ working: () => workingNow(services, "restart").length, events: services.events, logger, boot: bootFacts });
        shutdown.push(() => work.stop());
    }
    // The credential gateway, on loopback beside netd rather than behind it, up before any turn can be handed one of its
    // addresses (broker/broker-server.ts).
    const credentialGateway = await startCredentialGateway(services, logger);
    shutdown.push(() => credentialGateway.stop());
    // The ssh agent, its SSH half: the owner's socket, and every conversation socket a background job may still hold from
    // before a restart (broker/ssh-agent-sockets.ts). A socket that cannot bind is logged, and ssh then signs nothing.
    await services.sshAgent
        .start()
        .catch((error: unknown) => logger.warn({ err: error }, "ssh agent: could not start; ssh keys are unusable until restart"));
    shutdown.push(() => services.sshAgent.stop());
    // Pool machine preparing its volume for a future owner (prewarm.ts); nothing below branches on it except the very
    // end. Container-only: a guest or local folder has no volume to prepare.
    const prewarm = config.sandbox.prewarm && role.container;
    if (prewarm) {
        logger.info({ image: config.sandbox.image }, "prewarm boot: preparing this volume, then stopping");
    }
    // Wired here, not in composition, since its subject (`role`) was just computed; everything downstream trusts it
    // forever, resting on a claim file a second daemon's boot can overwrite.
    services.invariants.register(
        containerOwner,
        containerChecks({ role, roots: { workspaceRoot: config.workspaceRoot, historyRoot: config.historyRoot } }),
    );

    // What every phase below is handed; a phase reads its inputs from here instead of re-deriving them.
    const phase: BootPhase = { config, logger, traits, role, services, shutdown, stop };
    startDaemonMetrics(phase);

    // Every provider's boot task, declared by its own module, runs through one loop instead of a block per provider.
    // Each is fire-and-forget and best-effort: a provider that can't start is a log line, never a failed daemon.
    startProviderBoot(services, role, logger);
    armSetupPairings(phase);

    // Declares the readiness gate data routes await (app.ts): an early request waits instead of reading half-built
    // state, and a browser is told which step is running. Before the listeners, or a request could slip past it.
    declareBootSteps(services);
    attempt.stage = "Opening the netd door";
    const reach = await startNetdDoor(phase, host, netdSockets);
    // The netd door has dialled its sockets: no child inherits them from here on (daemon-env.ts).
    forgetDaemonOnlyEnv();
    startPlatformPresence(phase, reach);

    attempt.stage = "Running the boot chain";
    await runBootSteps(phase, runnerEnv);
    wireDependencyCoordinator(services);
    // Converged state opens the gate; everything below is background machinery no queued request depends on.
    services.boot.finish();
    return { phase, runnerEnv, prewarm, stop };
};

// Starts one phase past the gate, so a phase that throws is named in the log and the phases after it still start: none
// of them needs another to have started, and one failure must not silently leave restores, schedulers and watches off.
const startPhase = (logger: BootPhase["logger"], name: string, start: () => void): void => {
    try {
        start();
    } catch (error) {
        logger.error({ err: error, phase: name }, "boot: a phase past the gate failed to start; the phases after it still start");
    }
};

// Everything past the gate: none of it is a boot failure, and a throw here is only logged.
const pastGate = async ({ phase, runnerEnv, prewarm, stop }: Ready, fault: BootFault | undefined): Promise<void> => {
    const { config, logger, role, services } = phase;
    // This boot got all the way, so the last one's failure is no longer the news: the host reads the record's absence.
    if (role.container) {
        void clearBootFailure(config.historyRoot, logger);
    }
    // The build booted all the way on the files it converted: nothing needs undoing, and the host's update gate reads
    // the committed journal off /health.
    void commitStateAtBoot(phase);
    if (fault === "crash-after-ready") {
        logger.warn({ inMs: CRASH_AFTER_READY_MS }, "boot: INTENTIC_FAULT=crash-after-ready, so this daemon exits soon after the gate opened");
        setTimeout(() => process.exit(1), CRASH_AFTER_READY_MS);
    }

    // After the gate, so the editor is live while the dev servers come up; still after the stale-session sweep, which
    // must run before anything starts a session, and after the baseline, so a dev server's first build can't dirty it.
    await startWorkspaceApps(phase, prewarm).catch((error: unknown) =>
        logger.error({ err: error, phase: "workspace apps" }, "boot: the workspace's apps could not be started; the phases after it still start"),
    );
    // Logs CPU throttle alongside boot time, since on a shared-CPU host a slow chain is usually the quota, not the
    // steps.
    const cpu = await readCgroup().then(
        (cgroup) => cgroup.cpuThrottle,
        () => undefined,
    );
    logger.info({ ms: Date.now() - services.boot.progress().startedAt, cpu }, "boot: chain converged");

    // Parent link, for a runner (or one that ever was: an identity on /history outlives an env-stripping rebuild).
    // After the gate, since a parent's first act dispatches a turn. Never fatal: a failed enrollment just logs once.
    void startRunnerMode(services, runnerEnv).catch((error: unknown) => logger.error({ err: error }, "runner: could not come online"));

    startPhase(logger, "sweeps", () => startBootSweeps(phase));
    startPhase(logger, "restores", () => startBootRestores(phase));
    startPhase(logger, "schedulers", () => startBootSchedulers(phase));
    startPhase(logger, "resumes", () => startBootResumes(phase));
    startPhase(logger, "version watches", () => startVersionWatches(phase));
    startPhase(logger, "change reactions", () => startChangeReactions(phase));

    // A pool machine's boot ends here: the volume is prepared and the starter running, so it warms once, stamps the
    // volume, and takes the same exit SIGTERM would.
    if (prewarm) {
        void finishPrewarm({
            historyRoot: config.historyRoot,
            image: config.sandbox.image,
            processes: services.processes,
            logger,
            // Named here rather than inside prewarm.ts: this file sits above both subsystems StarterProbe needs.
            starterKey: appPanelKey(STARTER_REPO, STARTER_APP),
            answers: (port) => answers("http", port),
        })
            .catch((error: unknown) => logger.error({ err: error }, "prewarm: could not finish; the claimed boot prepares whatever is missing"))
            .finally(() => stop());
    }
};

const main = async (): Promise<void> => {
    // Read once: the update drill's hook (system/boot/fault.ts), never set on a production image.
    const fault = bootFault();
    const attempt: BootAttempt = { stage: "Reading the configuration", historyRoot: process.env["HISTORY_ROOT"] ?? HISTORY_ROOT };
    let ready: Ready;
    try {
        ready = await bootToGate(attempt, fault);
    } catch (thrown) {
        return failBoot(attempt, thrown instanceof Error ? thrown : new Error(String(thrown)));
    }
    await pastGate(ready, fault);
};

void main().catch((error: unknown) => {
    // Only past the gate, whose phases log their own failures: this is the backstop for one that escaped them.
    process.stderr.write(`daemon: the boot past the gate failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
});
