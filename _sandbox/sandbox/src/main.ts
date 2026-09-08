import { queueWhole } from "./agent/tools/agent-terminals.js";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DisposableStore } from "@intentic/base/lifecycle";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import { type ArrivalItem, STARTER_APP, STARTER_REPO } from "@intentic/sandbox-contract";
import { publicSlotFromToken, sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { defaultGit, observeGitCommands } from "@intentic/scaffold";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import { WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { sweepAgedAgents } from "./agents/registry/archive.js";
import { startVanishedRepoSweep } from "./agents/registry/vanished-repos.js";
import { streamAgent } from "./agent/routes/agent.routes.js";
import { createTurnResumeScheduler, resumeInterruptedTurns } from "./agent/run/turn/turn-resume.js";
import { startVerifyNudges } from "./agent/verification/verify-nudge.js";
import { restoreWatchers, startWatchers } from "./agent/verification/watchers.js";
import { resumeWorkflowExecution } from "./workflows/workflow-runner.js";
import { createAutomationsScheduler } from "./automations/scheduler.js";
import { emitWorkspaceEvent } from "./automations/workspace-events.js";
import { sweepAgedState, sweepStateAtBoot } from "./workspace/watch/state-janitor.js";
import { stateRelPath } from "./workspace/layout/state-paths.js";
import { capabilityCtx } from "./capabilities/capability.js";
import { restoreConnectorHooks } from "./capabilities/cli/connector-hooks.js";
import { linkSshHosts } from "./capabilities/ssh-hosts.js";
import { startTranslator } from "./agent/providers/translator.js";
import { onPath } from "./platform/boot/on-path.js";
import { DOCKER_PANEL_KEY, startDockerdIfEnabled } from "./capabilities/handlers/docker.handler.js";
import { localModelPanelKey, startLocalModelsIfEnabled } from "./capabilities/handlers/localmodel.handler.js";
import { writeAgentToken } from "./auth/agent-token.js";
import { createCiPoller } from "./ci/poller.js";
import { restoreExits } from "./exit/exit-links.js";
import { reconnectVpns } from "./vpn/vpn-links.js";
import { startProviderBoot } from "./agent/providers/provider-registry.js";
import { createServices } from "./composition.js";
import { approvalsExecutorFor } from "./approvals/approvals-executor.js";
import { ensureApprovalsSkill } from "./approvals/approvals-store.js";
import { startAllExtensionProcesses } from "./extensions/extension-processes.js";
import { startEngineWatch } from "./engines/engines.js";
import { startExtensionUpdateWatch } from "./extensions/extension-updates.js";
import { runGitMaintenance } from "./git/ops/maintenance.js";
import { pinTmuxServer, reportTmuxServerNamespace } from "./terminal/tmux-server.js";
import { prepushCheck } from "./prepush/prepush.js";
import { ensureRepoGitDirs } from "./git/remote/repo-git-dirs.js";
import { commitRootBaseline, ensureLocalRootRepo, ensureRootRepo } from "./git/remote/root-repo.js";
import { reconcileSkills } from "./settings/skills.js";
import { composeEnvironment } from "./environment/environment.js";
import { applyDefinitionItems } from "./portability/apply-definition.js";
import { parseDefinitionToml } from "./portability/definition.js";
import { sweepStaleExports } from "./portability/exports.js";
import { sweepArrivals } from "./portability/bundle-arrival.js";
import { queueVerify, type VerifyDeps } from "./workspace/deps/verify-deps.js";
import { type Config, loadConfig } from "./env.config.js";
import { createLogger } from "./logger.js";
import { applyTmuxLogHooks, logsRoot, pruneLogFiles, terminalLogsDir } from "./logs/log-files.js";
import { applyEventsPath, applyRunLive } from "./intentic/apply-events.js";
import { checkEventsDir } from "./intentic/check-run.js";
import { INFRA_APPLY_KEY } from "./intentic/infra-apply.js";
import { killStaleManagedSessions, panelSession } from "./processes/managed-processes.js";
import { killOrphanServiceProcesses } from "./processes/service-processes.js";
import { createPreviewProxy } from "./panels/preview-proxy.js";
import { publicRoot } from "./public/public-files.js";
import { createPublicHandler } from "./public/public-serve.js";
import { linkClaudeState } from "./sessions/session-store.js";
import type { BootTracker } from "./platform/boot/boot.js";
import { claimBootMarker } from "./platform/boot/boot-marker.js";
import { claimContainer } from "./platform/boot/container-owner.js";
import { checks as containerChecks, owner as containerOwner } from "./platform/invariant.js";
import { listenHost, profileTraits, requireLocalContract } from "./platform/boot/profile.js";
import { startLoopWatchdog } from "./platform/resources/loop-watchdog.js";
import { startIdleStop } from "./system/idle-stop.js";
import { startResourceMetrics } from "./platform/resources/resource-metrics.js";
import { startWorkloadPriorityGovernor } from "./platform/resources/workload-priority.js";
import { onTurnSettled, turnRunMetrics } from "./agent/run/turn/turn-runs.js";
import { browserSessionMetrics } from "./browser/sessions/browser-sessions.js";
import { unmaskableSecrets } from "./agent/tools/agent-redaction.js";
import { readLocalCertificate, startLocalCertificateRenewal } from "./platform/tls/local-cert.js";
import { reachPosture, startIngressTunnelWhenConfigured } from "./platform/listeners/ingress-tunnel.js";
import { createLoopbackListener } from "./platform/listeners/loopback-listener.js";
import { restoreAuthorizedKeys } from "./platform/sync.js";
import { seedSetupHost } from "./hosts/host-seed.js";
import { runnerModeRequested, startRunnerMode } from "./runners/runner-mode.js";
import { seedStarterSite } from "./scaffold/starter-site.js";
import { runAutostart } from "./scaffold/autostart.js";
import { arrivedPrewarmed, finishPrewarm } from "./platform/boot/prewarm.js";
import { answers } from "./ports/port-probe.js";
import { appPanelKey } from "./workspace/layout/app-previews.js";
import { readCpuThrottle } from "./platform/resources/cpu-throttle.js";
import { reapFinishedSessions } from "./terminal/terminal-session.js";
import { startVersionCheck } from "./platform/boot/version-check.js";
import { recordNewestRun } from "./store/newest-run.js";
import { startReleaseNotesCheck } from "./platform/boot/release-notes.js";
import { startRuntimeHealth } from "./agent/providers/adapter-health.js";
import { startSidecarService } from "./derived/sidecar-service.js";
import { startRepoWatch, subscribeRepoChanges } from "./workspace/watch/repo-watch.js";
import { startRefWatch, subscribeRefChanges } from "./git/remote/ref-watch.js";
import { startWorkspaceWatch, subscribeWorkspaceChanges } from "./workspace/watch/workspace-watch.js";

// Sandbox container's entrypoint; config comes from env injected at run time, never baked in. Listeners come up
// immediately (`/health`, `/events`); data routes wait behind the readiness gate below until the boot chain finishes.
// Steps are declared in BOOT_STEPS; an undeclared step is a type error, not a silent gap.
const BOOT_STEPS = [
    { key: "authorizedKeys", label: "Restoring desktop enrollments" },
    { key: "claudeState", label: "Linking conversation state" },
    { key: "sshHosts", label: "Linking ssh hosts" },
    { key: "vaultSecrets", label: "Securing stored credentials" },
    { key: "staleSessions", label: "Sweeping stale sessions" },
    { key: "rootRepo", label: "Preparing the workspace repo" },
    { key: "starterSite", label: "Putting your starter site in place" },
    { key: "autostart", label: "Starting your apps" },
    { key: "referenceShelf", label: "Ensuring the reference shelf" },
    { key: "staleExports", label: "Sweeping interrupted exports and arrivals" },
    { key: "repoGitDirs", label: "Healing repository git dirs" },
    { key: "definitionSeed", label: "Seeding the sandbox definition" },
    { key: "agentsRegistry", label: "Loading conversations" },
    { key: "skills", label: "Converging agent skills" },
    { key: "baseline", label: "Taking the workspace baseline" },
    { key: "agentToken", label: "Writing the agent token" },
] as const;

// Refuses to serve unauthenticated: an empty google.clientId is safe only when this daemon is unreachable. Reachable
// with it empty opens every gate in app.ts silently; SANDBOX_ALLOW_UNAUTHENTICATED is the one loud exception.
const requireAuthWhenReachable = (config: Config): void => {
    if (config.google.clientId !== "" || (config.connectToken === "" && config.sandbox.publicUrl === "")) {
        return;
    }
    if (config.sandbox.allowUnauthenticated) {
        process.stderr.write(
            "WARNING: SANDBOX_ALLOW_UNAUTHENTICATED is set, this daemon is reachable (CONNECT_TOKEN / SANDBOX_PUBLIC_URL)\n" +
                "and authenticates NOBODY: terminals, secrets and the file API answer any caller that reaches this port.\n" +
                "Only the e2e harnesses set this. If you are not one of them, unset it and set GOOGLE_CLIENT_ID instead.\n",
        );
        return;
    }
    // Before the logger: this must be legible in `docker logs` even when log config is part of what went wrong.
    process.stderr.write(
        "FATAL: this sandbox is externally reachable (CONNECT_TOKEN / SANDBOX_PUBLIC_URL is set) but GOOGLE_CLIENT_ID is empty.\n" +
            "Without it the daemon authenticates nobody and every route: terminals, secrets, the file API, is open to anyone\n" +
            "who can reach the tunnel. Set GOOGLE_CLIENT_ID to the platform's Google web client id and restart.\n",
    );
    process.exit(78); // EX_CONFIG
};

// Workspace-relative path is extension source (code or enablement) if it matches one of three locations. Module-scope
// so the watcher doesn't rebuild this on every change batch.
const extensionSource = (path: string): boolean =>
    path.startsWith(`${stateRelPath(".intentic/config/workspace-extensions/")}/`) ||
    path.startsWith(`${stateRelPath(".intentic/local/extensions/")}/`) ||
    path === stateRelPath(".intentic/config/extension-enablement.json");

const main = async (): Promise<void> => {
    // Runner mode is validated before anything else builds: a misassembled runner (runner-mode.ts) crashes here with
    // the reason logged, rather than half-booting. A well-formed runner otherwise boots like any loopback sandbox.
    const runnerEnv = runnerModeRequested(process.env);
    const config = loadConfig();
    requireAuthWhenReachable(config);
    requireLocalContract(config);
    // Profile differences below read a named trait, never the profile value directly (platform/profile.ts).
    const traits = profileTraits(config);
    const host = listenHost(config);
    if (!traits.sharedTmux) {
        // No shared tmux server for agent commands; defaults INTENTIC_AGENT_TMUX off, not forced, so an operator can
        // override.
        process.env["INTENTIC_AGENT_TMUX"] ??= "0";
    }
    // intentic CLI runs spawned here tee output to the daemon-owned logs tree via INTENTIC_LOG_DIR.
    process.env["INTENTIC_LOG_DIR"] ??= join(logsRoot(config.historyRoot), "intentic-runs");
    // Inherited by bin/tmux-run and the output filter via the agent env, so both agree where raw pane logs live.
    process.env["INTENTIC_TERMINAL_LOGS_DIR"] ??= terminalLogsDir(config.historyRoot);
    const logger = createLogger(config);
    // Logs and continues rather than exiting: the daemon must stay up for /agent and /events even when a best-effort
    // boot job rejects. The config-load throw above this stays unguarded on purpose; a bad config should crash loudly.
    process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled rejection"));
    process.on("uncaughtException", (err) => logger.error({ err }, "uncaught exception"));
    // Names the previous run's unannounced death (with its fatal report, if V8 wrote one) and stamps this run's marker;
    // the exit hook flips it to "exited" on a deliberate stop. Skipped with no history volume (dev, tests).
    if (config.historyRoot !== "") {
        const bootMarker = claimBootMarker(logsRoot(config.historyRoot), logger);
        process.on("exit", (code) => bootMarker.markExited(code));
    }
    // Every subsystem registers its own teardown at creation; nothing here enumerates what to stop.
    const shutdown = new DisposableStore();
    // Stall detector: logs the lag and the machine's pressure numbers when the event loop freezes.
    const loopWatchdog = startLoopWatchdog(logger);
    shutdown.push(() => loopWatchdog.stop());
    // Keeps direct children (provider SDKs spawn CLIs outside the Bash/git wrappers) below /events heartbeats in
    // priority.
    const workloadPriority = startWorkloadPriorityGovernor();
    shutdown.push(() => workloadPriority.stop());
    const services = createServices(config, logger);
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
    const resourceMetrics = startResourceMetrics({
        historyRoot: config.historyRoot,
        logger,
        owners: () => ({
            ...services.resourceOwners(),
            turnRuns: turnRunMetrics(),
            browserSessions: browserSessionMetrics(),
            reaper: services.reaper.metrics(),
            // Surfaces invariant violations in the same resource series already asked "what is this daemon holding".
            invariants: { violations: services.invariants.violations().length },
        }),
    });
    shutdown.push(() => resourceMetrics.stop());
    // Every git run is attributed to the perf tracker. `dir` is trimmed workspace-relative to keep lines short; `args`
    // drops trailing pathspecs (could be hundreds) but keeps the subcommand.
    observeGitCommands(({ dir, args, ms, execMs, attempts, failed, forked, queueDepth }) => {
        const fields = {
            git: args.slice(0, 3).join(" "),
            repo: dir.startsWith(services.workspace.root) ? dir.slice(services.workspace.root.length + 1) || "root" : dir,
            ...(attempts > 1 ? { lockRetries: attempts - 1 } : {}),
            // Recorded only when false: a direct exec (not forked) pays a page-table copy, a real source of slowness.
            ...(forked ? {} : { forked: false }),
            ...(queueDepth > 0 ? { queueDepth } : {}),
        };
        services.perf.record("git.run", ms, { ...fields, execMs: Math.round(execMs) }, failed);
        // Filed as its own op so the summary separates git's own time from wait. Never negative: the two clocks are
        // read across an IPC hop, so a fast call can show a hair more exec time than wall time.
        services.perf.record("git.run.wait", Math.max(0, ms - execMs), fields, failed);
    });

    // Every provider's boot task, declared by its own module, runs through one loop instead of a block per provider.
    // Each is fire-and-forget and best-effort: a provider that can't start is a log line, never a failed daemon.
    startProviderBoot(services, role, logger);

    // Arms the setup pairing token so the connect script's agent can enroll; no-op once redeemed (the burn is recorded
    // so a restart can't replay it). Detached: the connect script retries on its own.
    if (config.syncPairToken !== "") {
        void services.syncPairings
            .arm(config.syncPairToken, "sync")
            .catch((error: unknown) => logger.warn({ err: error }, "setup pairing not armed, enable desktop sync from the browser instead"));
    }

    // Creates the connected-device card once (its id is remembered so a deleted device isn't re-offered) and re-arms
    // its pairing every boot, since a late machine agent still needs a live token. Detached like the sync seed above.
    if (config.hostPairToken !== "") {
        void seedSetupHost(services, { token: config.hostPairToken, platform: config.hostPlatform, label: config.hostLabel })
            .then(({ offered, id }) => {
                if (offered) {
                    logger.info(
                        { host: id },
                        "setup device connected: it may manage this machine's sandboxes; widen or revoke on its capability card",
                    );
                }
            })
            .catch((error: unknown) =>
                logger.warn({ err: error }, "setup device not connected, add it from Capabilities to manage this machine's sandboxes"),
            );
    }

    // Declares the readiness gate data routes await (app.ts): an early request waits instead of reading half-built
    // state, and a browser is told which step is running.
    services.boot.declare(BOOT_STEPS);

    const app = createApp(services);
    // `/system/terminal`'s WebSocket rides node-server's native upgrade support. Cast bridges a type-only mismatch
    // between ws's `boolean | undefined` and node-server's plain-boolean option; the shapes match at runtime.
    const terminalSockets = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    const server = serve({ fetch: app.fetch, port: config.sandbox.port, hostname: host, websocket: { server: terminalSockets } });
    shutdown.push(() => server.close());
    logger.info(
        { host, port: config.sandbox.port, workspace: config.workspaceRoot, profile: config.sandbox.profile },
        "intentic sandbox daemon listening",
    );

    // Same app on a second, loopback-only port, so a local browser skips the tunnel round trip. HTTP and TLS share this
    // one port by sniffing the first byte; its own WebSocket server, since `ws` binds one per HTTP server.
    const localCertificate = traits.extraListeners ? readLocalCertificate(config) : undefined;
    const localSockets = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    // Meaningless when the only listener is already loopback; the local profile serves just one plain port.
    const localServer = !traits.extraListeners
        ? undefined
        : createLoopbackListener({
              fetch: app.fetch,
              port: config.local.port,
              hostname: host,
              sockets: localSockets,
              certificate: localCertificate,
          });
    shutdown.push(() => localServer?.close());
    if (localServer !== undefined) {
        logger.info({ port: config.local.port, tls: localServer.tls(), hostname: localCertificate?.hostname }, "loopback listener ready");
    }
    // Renews in the background and hands the listener whatever comes back, never rejecting. Never on a hosted machine
    // (SANDBOX_VM): there is no same-machine browser to serve, and issuing one there wastes a shared cert quota for
    // nothing.
    const localCertRenewal =
        role.container && traits.extraListeners && !config.sandbox.vm
            ? startLocalCertificateRenewal(config, logger, (certificate) => {
                  localServer?.useCertificate(certificate);
                  logger.info({ hostname: certificate.hostname }, "loopback listener is serving TLS");
              })
            : undefined;
    shutdown.push(() => localCertRenewal?.stop());

    // Routes preview-, port-, and public- subdomains by the Host header to a panel, a forwarded port, or the outbox;
    // always listening, answering 502 rather than refusing. public/'s existence is checked per request.
    const previewProxy = !traits.extraListeners
        ? undefined
        : createPreviewProxy({
              panelOf: services.panelUpstreamOf,
              slotTargetOf: services.portForwards.targetOf,
              sandboxId: sandboxIdFromToken(config.connectToken),
              // Daemon's own address; makes this proxy the container's one front door.
              daemonPort: config.sandbox.port,
              outbox:
                  config.connectToken === ""
                      ? undefined
                      : { slot: publicSlotFromToken(config.connectToken), serve: createPublicHandler(publicRoot(config.workspaceRoot)) },
          });
    previewProxy?.listen(config.preview.port, host);
    shutdown.push(() => previewProxy?.close());

    /* HOW THE WORLD REACHES THIS SANDBOX: one outbound dial (platform/ingress-tunnel.ts), or nothing at all.
     *
     * It lives HERE, in the daemon, rather than in the entrypoint that used to arrange it, and that move is
     * the whole shape of the change: reachability stopped being state somebody provisions before the process
     * starts (an account, a claimed name, a bound share, a predecessor to evict) and became a signature this
     * container was handed and presents. Nothing is created, so nothing leaks and nothing has to be reclaimed.
     *
     * A hosted machine (SANDBOX_VM) dials nothing: it is a Fly app the platform's edge replays requests to,
     * and Fly's proxy delivers them to the preview proxy above, the same front door a tunnel would land on.
     *
     * Gated on the front door existing, not merely on the config: the tunnel forwards every hostname to the
     * preview proxy, so without one there is nowhere to forward to. A daemon with no grant, no edge or no
     * proxy is simply loopback-only — a test, a `local` profile, a platform running no fabric — which is a
     * posture, never a failure. */
    /* HOW THIS SANDBOX IS REACHED, asked once here because two things downstream need the same answer: the
     * tunnel that may have to be dialled, and the reporter that tells the setup screen whether anybody can
     * get here at all. Both read `reachPosture`, so neither can hold an opinion the other does not. */
    const reach = reachPosture({ url: config.ingress.url, grant: config.sandbox.grant, frontDoor: traits.extraListeners, vm: config.sandbox.vm });
    const ingressTunnel = startIngressTunnelWhenConfigured({
        url: config.ingress.url,
        grant: config.sandbox.grant,
        targetPort: config.preview.port,
        frontDoor: traits.extraListeners,
        vm: config.sandbox.vm,
        log: (message, error) => (error === undefined ? logger.info(message) : logger.warn({ err: error }, message)),
    });
    shutdown.push(() => ingressTunnel?.close());

    // Announces this sandbox's URL to the platform registry once per boot, retried until acked, so the setup wizard
    // sees it online unprompted. Started with the listeners so it can't queue behind the sweeps it reports through.
    if (config.platform.url !== "" && config.sandbox.publicUrl !== "" && config.connectToken !== "") {
        if (role.container) {
            services.announcer.start();
            /* And immediately: does that public URL actually answer? Started here rather than after the boot
             * chain for the same reason the announce is, a waiting browser is reading exactly this, and it
             * has to hear "checking" while the tunnel comes up rather than nothing at all. The two are
             * separate claims deliberately (see reach-report.ts); registering says the daemon exists,
             * this says somebody can get to it. */
            services.reach.start(reach);
        }
    }

    // Hosted idle-stop: after a quiet window (nobody connected, no turn, no terminal activity) the daemon exits
    // gracefully so its machine can stop; the platform restarts it on the next visit. 0 means always-on.
    if (config.idleStopMinutes > 0 && role.container) {
        shutdown.push(startIdleStop({ minutes: config.idleStopMinutes, logger }));
    }

    // Asks the platform for this sandbox's trial allowance so it's ready before the user's first chat, not a sweep
    // later. Unawaited and self-swallowing: a platform that never answers just means no trial offered.
    if (role.container) {
        void services.trial.refresh();
    }

    // Every awaited step below runs through this tracker: stamps state and elapsed time, logs slow ones, streams
    // progress to any watching browser. Narrowed to BOOT_STEPS' keys, so an undeclared step is a compile error.
    const boot: BootTracker<(typeof BOOT_STEPS)[number]["key"]> = services.boot;

    // ~/.ssh and ~/.claude are shared by every process in the container; only the daemon that owns it may converge them
    // onto its roots, or a second daemon here would repoint the live daemon's git keys and conversation state.
    const ownsHome = role.container;

    // Enrollments live on /history and outlive the container; authorized_keys (container-local) is rebuilt from the
    // store before sshd serves a reconnect. Ordered before the gate, or enrollments stay valid but unauthorized.
    await boot.step("authorizedKeys", async () => {
        if (!ownsHome) {
            return;
        }
        await restoreAuthorizedKeys(config.historyRoot).catch((error: unknown) =>
            logger.warn({ err: error }, "authorized_keys not restored, enrolled machines will be refused until they re-enroll"),
        );
    });

    // Claude session state (transcripts, plans, todos) lives under the SDK's ephemeral ~/.claude; converged onto /work
    // before the gate opens so no turn can race it. Awaited: a CLI spawned mid-link would fork the stores.
    await boot.step("claudeState", async () => {
        if (!ownsHome) {
            return;
        }
        await linkClaudeState(services.workspace.root).catch((error: unknown) =>
            logger.warn({ err: error }, "claude session state not persisted, sessions will not survive a rebuild whole"),
        );
    });

    // ssh dir (git-provider keys, capability keys) also lived in ephemeral HOME; pointed at /history before anything
    // reads or writes an alias, or a rebuild silently drops git and ssh access. Awaited for that ordering.
    await boot.step("sshHosts", async () => {
        if (!ownsHome) {
            return;
        }
        await linkSshHosts(config.historyRoot).catch((error: unknown) =>
            logger.warn({ err: error }, "ssh hosts dir not persisted, git access and ssh aliases will not survive a rebuild"),
        );
    });

    // Capability credential values live out of the agent-readable manifest, in a separate store; only a save moves
    // them, so an entry connected before the split can still be exposed. Swept before the gate opens; best-effort.
    await boot.step("vaultSecrets", async () => {
        const moved = await services.vaultManifestSecrets().catch((error: unknown) => {
            logger.warn({ err: error }, "capability credentials: could not be moved out of the manifest, they stay readable to the agent");
            return [];
        });
        if (moved.length > 0) {
            logger.info({ capabilities: moved }, "capability credentials moved out of the workspace manifest into the private store");
        }
        // Same sweep for extension settings: unlike the manifest, this file is tracked, so an unswept secret would be
        // committed, not just readable.
        const settings = await services.vaultExtensionSettingSecrets().catch((error: unknown) => {
            logger.warn({ err: error }, "extension setting secrets: could not be moved out of the tracked file, they stay readable to the agent");
            return [];
        });
        if (settings.length > 0) {
            logger.info({ extensions: settings }, "extension setting secrets moved out of the tracked settings file into the private store");
        }
        // Masking (agent-redaction.ts) replaces a stored value with its `{{secret:name}}` reference in every tool
        // result, but has a length floor below which a value is silently unmasked. Warned by name here, once per boot.
        const unmaskable = unmaskableSecrets(await services.secretRegistry().catch(() => []));
        if (unmaskable.length > 0) {
            logger.warn(
                { secrets: unmaskable },
                "these stored secrets are too short to mask, so they reach the model in full when something reads them: replace them with longer values",
            );
        }
    });

    // Kills leftover panel/agent/job tmux sessions from a previous daemon, except a live infra apply or dockerd,
    // re-adopted instead. Runs before any step that starts its own process (main-boot-order.test.ts pins the order).
    await boot.step("staleSessions", async () => {
        // Container-wide: the tmux server is shared, so these sessions belong to whoever owns the container.
        if (!role.container) {
            return;
        }
        const applyLive =
            (await applyRunLive(applyEventsPath(config.historyRoot)).catch(() => false)) &&
            (await services.processes.adopt(INFRA_APPLY_KEY, { oneShot: true }).catch(() => false));
        const dockerAlive = await services.processes.adopt(DOCKER_PANEL_KEY, {}).catch(() => false);
        // Adopted for the same reason as dockerd, but pricier to get wrong: killing a live model server discards a
        // loaded model, costing minutes to reload.
        const modelKeys = (await services.capabilities.list().catch(() => [])).flatMap((capability) =>
            capability.kind === "localmodel" ? [localModelPanelKey(capability.id)] : [],
        );
        const modelsAlive: string[] = [];
        for (const key of modelKeys) {
            if (await services.processes.adopt(key, {}).catch(() => false)) {
                modelsAlive.push(panelSession(key));
            }
        }
        await killStaleManagedSessions([
            ...(applyLive ? [panelSession(INFRA_APPLY_KEY)] : []),
            ...(dockerAlive ? [panelSession(DOCKER_PANEL_KEY)] : []),
            ...modelsAlive,
        ]).catch(() => undefined);
        // Catches extension-gateway children of a daemon that died without unwinding; they survive in their own process
        // groups, holding connections the restore below would duplicate. A clean shutdown already stopped them.
        await killOrphanServiceProcesses(logger).catch(() => undefined);
    });

    // Inits the /work repo once, heals the .git pointer, converges excludes; a failure reads as not-fresh, so the
    // baseline commit below is skipped. Local roots are taken as they stand (ensureLocalRootRepo).
    const freshRoot = await boot.step("rootRepo", async () =>
        !role.roots
            ? false
            : (traits.relocateGitDirs
                  ? ensureRootRepo(services.workspace, config.historyRoot, defaultGit, services.workspaceArrivedEmpty)
                  : ensureLocalRootRepo(services.workspace, defaultGit, services.workspaceArrivedEmpty)
              ).catch((error: unknown) => {
                  logger.warn({ err: error }, "root workspace repo not ensured, the Changes review will degrade");
                  return false;
              }),
    );

    // Copies the starter site and starts its dev server on a fresh workspace only, before the baseline commit: the
    // seed's repo must exist first, or its files show as a phantom add. A failure just opens the workspace empty.
    await boot.step("starterSite", async () => {
        if (!role.roots || !freshRoot || !traits.ownsWorkspaceConfig) {
            return;
        }
        const outcome = await seedStarterSite(services).catch((error: unknown) => {
            logger.warn({ err: error }, "starter site not seeded, the workspace opens empty");
            return undefined;
        });
        if (outcome === undefined) {
            return;
        }
        if ("repo" in outcome) {
            logger.info({ repo: outcome.repo }, "starter site seeded");
            return;
        }
        // Logged only here (the one boot meant to seed), since the reason for an empty workspace is otherwise
        // unrecoverable.
        logger.info({ why: outcome.skipped }, "starter site not seeded, the workspace opens as it arrived");
    });

    // Restarts whatever the workspace declares should be running, since panels never survive a restart (the sweep above
    // kills them on purpose). Runs after both the seed (which writes the first entry) and the sweep; idempotent.
    await boot.step("autostart", async () => {
        if (!role.roots || !traits.ownsWorkspaceConfig) {
            return;
        }
        const outcome = await runAutostart(services).catch((error: unknown) => {
            logger.warn({ err: error }, "autostart: the list could not be read, nothing started");
            return undefined;
        });
        if (outcome !== undefined && (outcome.started.length > 0 || outcome.skipped.length > 0)) {
            logger.info(outcome, "autostart: workspace apps");
        }
    });

    // Reference shelf dir is furniture like .intentic: its presence on disk is the affordance, since scanners already
    // exclude it. Gated like other config writes: not the daemon's to place in a folder it doesn't own.
    await boot.step("referenceShelf", async () =>
        !role.roots || !traits.ownsWorkspaceConfig
            ? undefined
            : mkdir(join(config.workspaceRoot, REFERENCE_DIR), { recursive: true }).catch((error: unknown) =>
                  logger.warn({ err: error }, "reference shelf not ensured, refs/ drops have no target"),
              ),
    );

    // Sweeps both ends of the portability volume, which a restart invalidates: a half-written export is marked failed
    // instead of a frozen progress bar, and an arrival bundle whose review token died with the process is deleted.
    await boot.step("staleExports", async () =>
        !role.roots
            ? undefined
            : Promise.all([
                  sweepStaleExports(config.historyRoot).catch((error: unknown) =>
                      logger.warn({ err: error }, "stale exports not swept, an interrupted export may still read as packing"),
                  ),
                  sweepArrivals(config.historyRoot).catch((error: unknown) =>
                      logger.warn({ err: error }, "abandoned arrival spools not swept, they hold disk until the next boot"),
                  ),
              ]).then(() => undefined),
    );

    // Moves a repo's git dir out of /work so it resolves identically inside an isolated turn (agents/isolation.ts);
    // runs after rootRepo, before worktrees load. Skipped locally: those repos are the user's own.
    await boot.step("repoGitDirs", async () =>
        role.roots && traits.relocateGitDirs ? ensureRepoGitDirs(services.workspace, config.historyRoot, logger) : undefined,
    );

    // Seeds a runner's SANDBOX_DEFINITION_SEED into an empty workspace: repos cloned, connections listed, settings set,
    // overlay proposed. Guarded by workspaceArrivedEmpty so a replayed env can never run over real work.
    await boot.step("definitionSeed", async () => {
        if (!role.roots || !traits.ownsWorkspaceConfig || config.sandbox.definitionSeed === "") {
            return;
        }
        // A prewarmed volume (starter only, nothing the user's) still counts as empty for this gate.
        if (!services.workspaceArrivedEmpty && !(await arrivedPrewarmed(config.workspaceRoot, config.historyRoot))) {
            return;
        }
        try {
            const definition = parseDefinitionToml(Buffer.from(config.sandbox.definitionSeed, "base64").toString("utf8"));
            // On a runner, only `settings` items apply: no owner here to reconnect a capability or fill a secret. Repos
            // arrive separately through the parent's own git sync, carrying exact branches a clone can't.
            const pick = runnerEnv !== undefined ? (item: ArrivalItem): boolean => item.group === "settings" : (): boolean => true;
            const report = await applyDefinitionItems(services, definition, pick);
            logger.info({ report }, "sandbox definition seeded; its needsAction list is the owner's arrival checklist");
        } catch (error) {
            logger.warn({ err: error }, "sandbox definition not seeded, the workspace opens as it arrived");
        }
    });

    // Loads persisted conversations and broadcasts the roster, so an /events stream opened mid-boot doesn't see an
    // empty fleet. Awaited (routes assume it's loaded), but a failure just leaves the fleet empty, not the daemon dead.
    await boot.step("agentsRegistry", () =>
        services.agents.init().catch((error: unknown) => logger.warn({ err: error }, "agents registry not initialized, the fleet starts empty")),
    );

    // Converges daemon-owned /work skill files before the baseline commit, so a fresh sandbox reads clean instead of a
    // phantom add.
    // - the approvals skill: how the agent writes posts/actions for approval
    // - the baked-tool skills named in settings
    await boot.step("skills", async () => {
        // Gated like other config writes: an unowned folder gets no writes under .agents/skills.
        if (!role.roots || !traits.ownsWorkspaceConfig) {
            return;
        }
        await ensureApprovalsSkill(services).catch((error: unknown) => logger.warn({ err: error }, "approvals skill not converged"));
        await services.sandboxSettings
            .get()
            .then((settings) => reconcileSkills(services, settings.skills))
            .catch((error: unknown) => logger.warn({ err: error }, "skill reconcile failed"));
    });

    // Commits "Initialize workspace" once on a fresh sandbox, after daemon-owned files exist, so Changes starts clean.
    await boot.step("baseline", async () => {
        if (freshRoot) {
            await commitRootBaseline(services.workspace).catch((error: unknown) =>
                logger.warn({ err: error }, "root baseline commit failed, the Changes review will start dirty"),
            );
        }
    });

    // A previous boot's check runs left per-run event files behind (their streams died with the daemon).
    if (role.roots) {
        void rm(checkEventsDir(config.historyRoot), { recursive: true, force: true });
    }

    // vpn CLI reads this to reach the daemon's /vpn routes; written before the restores below need it.
    await boot.step("agentToken", async () => {
        // Token lives at a fixed container path (/run) for in-container vpn/otp CLIs; a local daemon has neither.
        if (!traits.containerCapabilities) {
            return;
        }
        await writeAgentToken(services.agentToken).catch((error: unknown) => services.logger.warn({ err: error }, "agent token: could not write"));
    });

    // Wired before the data gate opens, though the watcher itself starts below: registering now means a turn arriving
    // the instant boot finishes queues behind an already-reserved repair, instead of racing to discover the stale tree.
    const dependencyChecks: VerifyDeps = {
        workspace: services.workspace,
        processes: services.processes,
        logger: services.logger,
        verifyStore: services.verifyStore,
        activity: services.activity,
        emit: (event) => emitWorkspaceEvent(services, event, streamAgent),
        queue: queueWhole(services.heavyCommands.read),
    };
    services.dependencies.subscribe(({ dir, origin }) => {
        const named = dir === "" ? `the workspace root` : dir;
        const conversationId = origin.kind === "land" ? origin.agentId : origin.kind === "request" ? origin.conversationId : undefined;
        const title = origin.kind === "land" || origin.kind === "request" ? origin.title : undefined;
        const reason =
            origin.kind === "land"
                ? "changes from this conversation left the installed tree behind"
                : origin.kind === "request"
                  ? origin.conversationId === undefined
                      ? "setup was requested outside a conversation"
                      : "setup was requested from this conversation"
                  : origin.kind === "startup"
                    ? "the daemon found the installed tree behind during startup"
                    : "a workspace change left the installed tree behind";
        void services.activity
            .append({
                direction: "system",
                type: "deps.install_started",
                content: `Installing dependencies for ${named}, ${reason}.`,
                outcome: "ok",
                ...(conversationId === undefined ? {} : { conversationId }),
                ...(title === undefined ? {} : { title }),
            })
            .catch((error: unknown) => logger.warn({ err: error }, "dependency coordinator: activity append failed"));
        queueVerify(dependencyChecks, origin, [dir]);
    });
    services.dependencies.subscribeFailures(({ dir, origin }) => {
        const named = dir === "" ? `the workspace root` : dir;
        const conversationId = origin.kind === "land" ? origin.agentId : origin.kind === "request" ? origin.conversationId : undefined;
        const title = origin.kind === "land" || origin.kind === "request" ? origin.title : undefined;
        void services.activity
            .append({
                direction: "system",
                type: "deps.install_failed",
                content: `Dependency installation for ${named} could not start. The project remains behind and will retry on the next readiness check.`,
                outcome: "error",
                ...(conversationId === undefined ? {} : { conversationId }),
                ...(title === undefined ? {} : { title }),
            })
            .catch((error: unknown) => logger.warn({ err: error }, "dependency coordinator: failure activity append failed"));
    });
    services.dependencies.watch(subscribeWorkspaceChanges);

    // Converged state opens the gate; everything below is background machinery no queued request depends on.
    boot.finish();
    // Logs CPU throttle alongside boot time, since on a shared-CPU host a slow chain is usually the quota, not the
    // steps.
    logger.info({ ms: Date.now() - boot.progress().startedAt, cpu: readCpuThrottle() }, "boot: chain converged");

    // Parent link, for a runner (or one that ever was: an identity on /history outlives an env-stripping rebuild).
    // After the gate, since a parent's first act dispatches a turn. Never fatal: a failed enrollment just logs once.
    void startRunnerMode(services, runnerEnv).catch((error: unknown) => logger.error({ err: error }, "runner: could not come online"));

    // Invariant checks are driven from here since this file knows the boot moments. Detached, so a check can't cause
    // the outage it diagnoses; run after the gate, since the boot steps establish the state being checked.
    void services.invariants.run("boot");
    const invariantSweep = setInterval(() => void services.invariants.run("sweep"), 300_000);
    shutdown.push(() => clearInterval(invariantSweep));
    shutdown.push(onTurnSettled(() => void services.invariants.run("turn-settled")));

    // Backfills the search index after the gate: turns write it forward in steady state, so this matters only on first
    // run, a schema bump, or downtime. Detached; routes report `indexing` meanwhile.
    const backfillSaid = (): void => {
        void services.saidIndex.backfill().catch((error: unknown) => logger.warn({ err: error }, "search index backfill failed"));
    };
    backfillSaid();
    const saidSweep = setInterval(backfillSaid, 600_000);
    saidSweep.unref();
    shutdown.push(() => clearInterval(saidSweep));

    // Detached: archives entries whose checkout vanished, prunes orphaned dirs, parks off-board branches. Reads the
    // registry through callbacks and takes per-repo locks, so a turn starting mid-walk is safe.
    void (async () => {
        const vanished: string[] = [];
        const archived: string[] = [];
        for (const id of services.agents.ids()) {
            const entry = services.agents.entry(id);
            // Workspace conversations own no checkout by design; missing on disk doesn't mean vanished here.
            if (entry?.branch === undefined) {
                continue;
            }
            // An archived entry has no worktree by design (reclaimed); held by its commits, not this vanished-case
            // check.
            if (entry.archivedAt !== undefined) {
                archived.push(id);
                continue;
            }
            if (!(await services.agentWorktrees.exists(id))) {
                vanished.push(id);
            }
        }
        // A live entry with no checkout becomes archived, held by its branch; deletion stays where the user can see it
        // (discard, or the archive's own purge).
        if (vanished.length > 0) {
            await services.agents.setArchived(vanished, Date.now());
            logger.info({ count: vanished.length }, "agents: archived entries whose worktree vanished");
        }
        // Membership is re-read per decision inside prune, so a conversation opened mid-sweep isn't judged by this
        // snapshot.
        await services.agentWorktrees.prune(
            () => services.agents.ids().filter((id) => services.agents.entry(id)?.branch !== undefined),
            () =>
                services.agents
                    .ids()
                    .filter((id) => services.agents.entry(id)?.branch !== undefined && services.agents.entry(id)?.archivedAt !== undefined),
        );
    })().catch((error: unknown) => logger.warn({ err: error }, "agents: boot worktree sweep failed"));

    // Archives Finished agents past the retention window (agentRetentionDays; 0 disables) so the lane doesn't become a
    // permanent record. Once at boot, then hourly; losslessly (agents/archive.ts).
    const sweepArchive = (): Promise<void> =>
        services.sandboxSettings
            .get()
            .then((settings) => sweepAgedAgents(services, Date.now(), settings.agentRetentionDays * 24 * 60 * 60 * 1000))
            .then(() => undefined)
            .catch((error: unknown) => logger.warn({ err: error }, "agents: archive sweep failed"));
    if (role.roots) {
        void sweepArchive();
        setInterval(() => void sweepArchive(), 60 * 60 * 1000).unref();
        // State dir's own garbage (scratch, retired derived roots, aged captures); same cadence and ownership guard as
        // the agent sweeps above.
        void sweepStateAtBoot(services.workspace.root, logger).catch((error: unknown) =>
            logger.warn({ err: error }, "state janitor: boot sweep failed"),
        );
        setInterval(
            () =>
                void sweepAgedState(services.workspace.root, Date.now(), logger).catch((error: unknown) =>
                    logger.warn({ err: error }, "state janitor: aged sweep failed"),
                ),
            60 * 60 * 1000,
        ).unref();
    }

    // Forks the tmux server here so every pane inherits this daemon's mounts, not a conversation's private /work; must
    // happen before any turn runs. Rechecked on a slow loop; a pre-existing server can't be pinned after the fact.
    if (role.roots) {
        void pinTmuxServer(logger).then(() => reportTmuxServerNamespace(logger));
        setInterval(() => void reportTmuxServerNamespace(logger), 15 * 60 * 1000).unref();
    }

    // Packs refs and loose objects, keeps the commit-graph current. Never awaited: its whole point is to run while
    // nothing is waiting, so a repo mid-relocation is simply maintained an hour later.
    const maintain = (): Promise<void> => runGitMaintenance(services.workspace, logger);
    if (role.roots) {
        void maintain();
        setInterval(() => void maintain(), 60 * 60 * 1000).unref();
    }

    // Recomposes the environment overlay from the manifest, converging drift when a capability's fragment changed;
    // no-op on a fresh sandbox. Writes stay under .intentic/, so this never touches the baseline above.
    if (role.container) {
        void composeEnvironment(services);
    }

    // VPN tunnels and dockerd die with the container while their manifests survive on /work; both are reconnected here,
    // after the sweep, best-effort (failures land in state or the log, not the boot path).
    const bootCtx = capabilityCtx(services);
    if (role.container) {
        void reconnectVpns(services.capabilities, services.logger);
        // Geo exits restore the same way, plus one step: a tunnel exit's client survives the daemon dying, but the
        // SOCKS proxy publishing it lived in this process, so this republishes it without disturbing the tunnel.
        void restoreExits(services.capabilities, services.logger);
    }
    // Connector side effects (credential helper, ssh Include, npmrc auth) lived in HOME and die with the container;
    // re-derived from the manifest so the first git or npm call authenticates. The owning daemon's job.
    if (ownsHome) {
        void restoreConnectorHooks(services.capabilities, services.logger);
    }
    if (role.container) {
        void startDockerdIfEnabled(bootCtx);
    }
    // Model servers die with the container like dockerd; weights survive on /work, so every ready one comes back.
    if (role.container) {
        void startLocalModelsIfEnabled(bootCtx);
    }
    // Backs "Codex/Grok under the Claude Code harness" via CLIProxyAPI. Gated on the binary being in this image (a
    // feature pack, not core): TRANSLATOR_URL alone no longer implies it's present.
    void (async () => {
        if (config.translator.url === "" || !role.container) {
            return;
        }
        if (!(await onPath("cli-proxy-api"))) {
            logger.info("translator: cli-proxy-api is not in this image, add it by rebuilding from the Environment card");
            return;
        }
        startTranslator(services);
    })().catch((error: unknown) => logger.warn({ err: error }, "translator: start gate failed"));
    // Installed extensions' declared autoStart processes come back the same way (manifests on /work).
    if (role.container) {
        void startAllExtensionProcesses(services);
    }
    // Extension backends (manifest `server` bundles) come up in their own supervised host process, proxied under
    // /x/<id>/. Best-effort: a failure is a row on the Extensions tab, not a boot failure.
    if (role.container) {
        services.extensionBackend.start().catch((error: unknown) => logger.warn({ err: error }, "extension backend host failed to start"));
    }

    // Re-arms tmux pipe-pane hooks on a server that outlived a daemon restart; tmux.conf covers server start, this is
    // best-effort.
    if (role.container) {
        void applyTmuxLogHooks(config.historyRoot);
    }
    // Root-scoped: these are the logs of whoever owns this history root, and a guest sharing it prunes nothing.
    if (role.roots) {
        void pruneLogFiles(logsRoot(config.historyRoot));
    }
    const logsSweep = role.roots ? setInterval(() => void pruneLogFiles(logsRoot(config.historyRoot)), 3_600_000) : undefined;
    shutdown.push(() => clearInterval(logsSweep));

    // Reaps abandoned web-* shells and finished job-* sessions, at boot and hourly. `keep` makes this safe unattended:
    // a job still queued has only dead panes but isn't finished. agent-* belongs to the reaper below.
    const stillWorking = (session: string): boolean => services.terminalRun.running(session);
    if (role.container) {
        void reapFinishedSessions(stillWorking);
    }
    const sessionSweep = role.container ? setInterval(() => void reapFinishedSessions(stillWorking), 3_600_000) : undefined;
    shutdown.push(() => clearInterval(sessionSweep));

    // Reclaims everything a stopped conversation still holds: its provider CLI tree, MCP servers and browsers, its
    // agent-* sessions, browser records, temp state, on its own stop clock. Container-role only.
    if (role.container) {
        services.reaper.start();
        void services.reaper.sweep();
    }
    shutdown.push(() => services.reaper.stop());

    // Scheduled agent wake-ups: poll the automations manifest and fire whatever the owner configured there.
    const scheduler = createAutomationsScheduler(services, streamAgent);
    shutdown.push(() => scheduler.stop());
    if (role.container) {
        scheduler.start();
    }

    // Agent-armed condition checks, polled between turns. Wired here since a wake is itself a turn. Stop clears the
    // timers only; the watch journal survives for the next boot to restore.
    shutdown.push(startWatchers(services, streamAgent));

    // Follow-up for runtimes with no SDK Stop hook: a turn that edited code and never checked it gets one bounded
    // follow-up turn. Wired here since the turn generator can't be imported from under the caller.
    shutdown.push(startVerifyNudges(services, streamAgent));

    // Armed, not polled: reads the queue and sleeps until the soonest approved item is due. Arming here is what
    // survives a restart, since the deadline is the item's own scheduledAt on disk, not this timer.
    const approvalsExecutor = approvalsExecutorFor(services);
    // Dropping the timer loses nothing: the deadline lives in the item's own scheduledAt, and the next boot re-arms
    // from it.
    shutdown.push(() => approvalsExecutor.stop());
    // A pre-push check runs a suite on the main tree; left alone at exit it burns CPU with nothing to report to.
    shutdown.push(() => prepushCheck(services).cancel());
    if (role.container) {
        void approvalsExecutor.arm().catch((error: unknown) => logger.warn({ err: error }, "approvals executor not armed"));
    }

    // Keeps every mapped repo's CI webhook pointed at this sandbox (boot + interval), so pipelines wake `ci`
    // automations.
    if (role.container) {
        services.ciHooks.start();
    }

    // Polls repos whose CI hook could not be registered (no public URL, a scopeless token) so their `ci` automations
    // still fire. Its first pass is a silent seed, so starting it early costs nothing (ci/poller.ts).
    const ciPoller = createCiPoller(services, streamAgent);
    shutdown.push(() => ciPoller.stop());
    if (role.container) {
        ciPoller.start();
    }

    // Refreshes expired maintenance measurements (pnpm outdated/audit, knip, jscpd) for the rail. Serialized, skipped
    // while any turn is live, and held behind a warm-up so it never races the boot's own pnpm install.
    if (role.container) {
        services.probeRunner.start();
    }

    // Detects what the live container has that the image didn't, drafting overlay steps to capture it. Same manners as
    // the probe runner: idle-only, allowed to fail, unref'd. Container-only: there's no image to drift from otherwise.
    if (role.container) {
        services.driftSweep.start();
    }

    // Re-runs a turn killed by a credential refusal or provider outage. A spent usage limit re-runs only if the owner
    // opted in: resumeAfterLimit (retry at reset) or moveAfterLimit (another account), both off by default.
    const turnResume = createTurnResumeScheduler(services, streamAgent);
    shutdown.push(() => turnResume.stop());
    if (role.roots) {
        turnResume.start();
    }

    // Restart resume: the turn journal holds every turn in flight, so whatever survived to here is what killed the
    // daemon. Re-run once each, gated and attempt-bounded. Detached: an interrupted turn is a whole turn.
    void resumeInterruptedTurns(services, streamAgent).catch((error: unknown) =>
        logger.error({ err: error }, "interrupted turns could not be resumed, they stand on the record as interrupted"),
    );

    // Same restart story for condition watches, sharper here since a watch's whole life is between turns. Each is
    // re-checked once, since it may have resolved during the rebuild, and re-armed with its remaining time.
    void restoreWatchers().catch((error: unknown) => logger.error({ err: error }, "armed condition watches could not be restored"));

    // Same restart story for loops and workflow runs, coordinated since every workflow step is itself a loop: the
    // coordinator reserves workflow-owned conversations before generic loop recovery sees the rest.
    void resumeWorkflowExecution(services, streamAgent).catch((error: unknown) =>
        logger.error({ err: error }, "loops and workflow runs could not be resumed"),
    );

    // Stamps the workspace with the newest version that ever ran it (forward-only), so a post-rollback manifest issue
    // reads as "written by a newer intentic", not "your file is broken". Backgrounded; gates nothing.
    if (role.roots) {
        void recordNewestRun(config.workspaceRoot).catch(() => undefined);
    }

    // Warms the "latest released version" cache so /info can offer an update without fetching on the request path.
    // Channel-aware: stable gets the promoted release, beta the newest; meaningless for a local daemon.
    const versionCheck = traits.containerUpdates ? startVersionCheck() : undefined;
    shutdown.push(() => versionCheck?.stop());

    // What an update would actually give: a separate read (the release's notes, not just its version pointer), same
    // cadence, neither blocking the /info that shows them.
    const releaseNotesCheck = traits.containerUpdates ? startReleaseNotesCheck() : undefined;
    shutdown.push(() => releaseNotesCheck?.stop());

    // Same courtesy for installed extensions: compares each pinned sha against its registry shortly after boot and
    // daily after; the Extensions tab's own reads keep it fresher still.
    const extensionUpdateWatch = traits.extensionHost ? startExtensionUpdateWatch(services) : undefined;
    shutdown.push(() => extensionUpdateWatch?.stop());

    // Same for the agent engines (Claude Code, Codex, Cursor, OpenCode, the translator): each engine's channel decides
    // its version source, acted on without a new image. Runs only where this daemon owns the container.
    const engineWatch = startEngineWatch(services, role);
    shutdown.push(() => engineWatch.stop());

    // Probes whether each runtime can serve a turn off the turn path, so a missing subscription surfaces before a
    // prompt is written.
    startRuntimeHealth(services);
    // Idle backstop for plan-limit headroom, re-read on every turn, refusal, or screen; this covers a sandbox where
    // nothing happens.
    services.headroom.start();

    // Realtime wake-ups run as provider-gateway extension processes (e.g. ext-discord) driving /listeners/<provider>;
    // the daemon holds no gateway of its own, started and kept in sync by the extension process machinery.

    // Workspace history: an immediate snapshot plus the interval sweep (turn snapshots ride on streamAgent).
    services.history.start();

    // Watches /work so the browser's tree and open file refresh instantly over /events, no manual refresh needed.
    startWorkspaceWatch(services.workspace.root, logger);
    // Search index revalidates on the same watch stream; a query serves the current index while reindexing happens
    // between queries.
    subscribeWorkspaceChanges(() => services.iq.markDirty());
    // Restarts the extension backend host when its source changes (an edit, a fresh checkout, an enablement flip):
    // loaded code can't be unloaded, so a debounced restart is the reload. No-op while no extension ships a backend.
    subscribeWorkspaceChanges((paths) => {
        if (paths.some(extensionSource)) {
            services.extensionBackend.restart();
        }
    });
    // Re-derives a binary file's markdown shadow (docx/pdf/image/audio) via a spawned `fileq` whenever it lands or
    // changes. Gated by the `sidecars` setting, read fresh each pass so the switch works without a restart.
    shutdown.push(startSidecarService({ enabled: async () => (await services.sandboxSettings.get()).sidecars, logger }, subscribeWorkspaceChanges));
    // Reframes the discovered repo list on /events when a repo is cloned or deleted under /work (the file watcher
    // itself ignores .git).
    startRepoWatch(services.workspace.root, logger);
    // Reframes commit-graph-derived surfaces on any ref move (commit, checkout, branch, tag, rebase) in any repo;
    // neither the file watcher (ignores .git) nor the repo watcher above can carry this.
    startRefWatch(services.workspace.root, subscribeRepoChanges, logger);
    // Health rankings include committed churn; a ref can move without a workspace byte changing, so only the ref feed
    // can invalidate this.
    shutdown.push(subscribeRefChanges(() => services.iq.invalidateHealth()));
    // Removes a deleted repo from every composition still naming it and reclaims its stranded checkouts: the one
    // correction a frozen composition can't make for itself (agents/vanished-repos.ts).
    shutdown.push(startVanishedRepoSweep(services, subscribeRepoChanges));

    // Warms the search index (sweep, symbols, embedding backlog) on its own worker thread so the first search is ready;
    // incremental, so a valid on-disk index survives a boot. Awaited only as an observation point.
    void services.iq.warm().catch((error: unknown) => logger.warn({ err: error }, "iq index warmup failed, search runs on the index as it stands"));

    // Nothing to enumerate: every subsystem registered its own teardown. Keeps going past a throwing member and reports
    // failures together. `finally`, since the exit must happen whatever the teardown did.
    const stop = (): void => {
        logger.info("shutting down intentic sandbox daemon…");
        try {
            shutdown.dispose();
        } catch (error) {
            logger.error({ err: error }, "shutdown: one or more subsystems failed to stop");
        } finally {
            // Fires the exit hook above, stamping the marker exited so the next boot reads a deliberate stop.
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
            // Named here, not imported below: this file sits above both subsystems StarterProbe needs.
            starterKey: appPanelKey(STARTER_REPO, STARTER_APP),
            answers: (port) => answers("http", port),
        })
            .catch((error: unknown) => logger.error({ err: error }, "prewarm: could not finish; the claimed boot prepares whatever is missing"))
            .finally(stop);
    }
};

void main();
