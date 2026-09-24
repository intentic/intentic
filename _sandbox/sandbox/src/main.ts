import { DisposableStore } from "@intentic/base/lifecycle";
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
import { prepareDaemonProcess, requireAuthWhenReachable } from "./bootstrap/daemon-env.js";
import { startDaemonMetrics } from "./bootstrap/daemon-metrics.js";
import { wireDependencyCoordinator } from "./bootstrap/deps-coordination.js";
import { startFrontDoor } from "./bootstrap/front-door.js";
import { startPlatformPresence } from "./bootstrap/platform-presence.js";
import { startVersionWatches } from "./bootstrap/version-watches.js";
import { startWorkspaceApps } from "./bootstrap/workspace-apps.js";
import { createServices } from "./composition.js";
import { loadConfig } from "./env.config.js";
import { claimContainer } from "./platform/boot/container-owner.js";
import { finishPrewarm } from "./platform/boot/prewarm.js";
import { listenHost, profileTraits, requireLocalContract } from "./platform/boot/profile.js";
import { checks as containerChecks, owner as containerOwner } from "./platform/invariant.js";
import { readCgroup } from "./platform/resources/cgroup.js";
import { startLoopWatchdog } from "./platform/resources/loop-watchdog.js";
import { oomScoreResolver } from "./platform/resources/oom-priority.js";
import { startOomScorer } from "./platform/resources/oom-scorer.js";
import { spawnDepthOf } from "./agent/subagents/children.js";
import { answers } from "./ports/port-probe.js";
import { runnerModeRequested, startRunnerMode } from "./runners/runner-mode.js";
import { appPanelKey } from "./workspace/layout/app-previews.js";

// Sandbox container's entrypoint; config comes from env injected at run time, never baked in. It settles the process,
// builds the services once, and then calls each phase of boot in the one order that is behavior: listeners come up
// immediately (`/health`, `/events`), data routes wait behind the readiness gate until the boot chain finishes, and
// everything past the gate is background machinery no queued request depends on. Each phase owns its own subject and
// registers its own teardown, so nothing here enumerates what to stop.
const main = async (): Promise<void> => {
    // Runner mode is validated before anything else builds: a misassembled runner (runner-mode.ts) crashes here with
    // the reason logged, rather than half-booting. A well-formed runner otherwise boots like any loopback sandbox.
    const runnerEnv = runnerModeRequested(process.env);
    const config = loadConfig();
    requireAuthWhenReachable(config);
    requireLocalContract(config);
    // Profile differences below read a named trait, never the profile value directly (platform/boot/profile.ts).
    const traits = profileTraits(config);
    const host = listenHost(config);
    const logger = prepareDaemonProcess(config, traits);

    // Every subsystem registers its own teardown at creation; nothing here enumerates what to stop.
    const shutdown = new DisposableStore();
    // Stall detector: logs the lag and the machine's pressure numbers when the event loop freezes.
    const loopWatchdog = startLoopWatchdog(logger);
    shutdown.push(() => loopWatchdog.stop());
    const services = createServices(config, logger);
    // Ranks the daemon's children for the OOM killer by role and spawn depth; the front renices them.
    const oomScorer = startOomScorer(oomScoreResolver((owner) => spawnDepthOf(services.conversations, owner)));
    shutdown.push(() => oomScorer.stop());
    shutdown.push(() => services.perf.stop());
    shutdown.push(() => services.ciHooks.stop());
    shutdown.push(() => services.announcer.stop());
    shutdown.push(() => services.reach.stop());
    shutdown.push(() => services.history.stop());
    shutdown.push(() => services.processes.stopAll());
    // Extension gateways are direct children; stopped here or they outlive the daemon (the orphan sweep is only a
    // backstop).
    shutdown.push(() => services.serviceProcesses.stopAll());
    // The backend host is a direct child, not a tmux session, stopped here or it outlives the daemon.
    shutdown.push(() => services.extensionBackend.stop());
    // Claims container ownership before anything container-wide runs, since a container can hold more than one daemon
    // (container-owner.ts). LOCAL never claims: it owns nothing container-wide, and its role is pinned, not derived.
    const role = traits.convergeHome
        ? await claimContainer({ workspaceRoot: config.workspaceRoot, historyRoot: config.historyRoot }, logger)
        : { container: false, roots: true };
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
    const phase: BootPhase = { config, logger, traits, role, services, shutdown };
    startDaemonMetrics(phase);

    // Every provider's boot task, declared by its own module, runs through one loop instead of a block per provider.
    // Each is fire-and-forget and best-effort: a provider that can't start is a log line, never a failed daemon.
    startProviderBoot(services, role, logger);
    armSetupPairings(phase);

    // Declares the readiness gate data routes await (app.ts): an early request waits instead of reading half-built
    // state, and a browser is told which step is running. Before the listeners, or a request could slip past it.
    declareBootSteps(services);
    const reach = await startFrontDoor(phase, host);
    startPlatformPresence(phase, reach);

    await runBootSteps(phase, runnerEnv);
    wireDependencyCoordinator(services);
    // Converged state opens the gate; everything below is background machinery no queued request depends on.
    services.boot.finish();

    // After the gate, so the editor is live while the dev servers come up; still after the stale-session sweep, which
    // must run before anything starts a session, and after the baseline, so a dev server's first build can't dirty it.
    await startWorkspaceApps(phase, prewarm);
    // Logs CPU throttle alongside boot time, since on a shared-CPU host a slow chain is usually the quota, not the
    // steps.
    logger.info({ ms: Date.now() - services.boot.progress().startedAt, cpu: (await readCgroup()).cpuThrottle }, "boot: chain converged");

    // Parent link, for a runner (or one that ever was: an identity on /history outlives an env-stripping rebuild).
    // After the gate, since a parent's first act dispatches a turn. Never fatal: a failed enrollment just logs once.
    void startRunnerMode(services, runnerEnv).catch((error: unknown) => logger.error({ err: error }, "runner: could not come online"));

    startBootSweeps(phase);
    startBootRestores(phase);
    startBootSchedulers(phase);
    startBootResumes(phase);
    startVersionWatches(phase);
    startChangeReactions(phase);

    // Nothing to enumerate: every subsystem registered its own teardown. Keeps going past a throwing member and reports
    // failures together. `finally`, since the exit must happen whatever the teardown did.
    const stop = (): void => {
        logger.info("shutting down intentic sandbox daemon…");
        try {
            shutdown.dispose();
        } catch (error) {
            logger.error({ err: error }, "shutdown: one or more subsystems failed to stop");
        } finally {
            // Fires the exit hook in daemon-env.ts, stamping the marker exited so the next boot reads a deliberate stop.
            process.exit(0);
        }
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);

    // A pool machine's boot ends here: the volume is prepared and the starter running, so it warms once, stamps the
    // volume, and takes the same exit SIGTERM would. Placed after every handler above, so the exit is the ordinary one.
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
            .finally(stop);
    }
};

void main();
