import { mkdir, rm } from "node:fs/promises";
import { createSecureServer } from "node:http2";
import { join } from "node:path";
import { DisposableStore } from "@intentic/base/lifecycle";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import { publicSlotFromToken, sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { observeGitCommands } from "@intentic/scaffold";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import { WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { sweepAgedAgents } from "./agents/archive.js";
import { startVanishedRepoSweep } from "./agents/vanished-repos.js";
import { streamAgent } from "./agent/agent.routes.js";
import { createTurnResumeScheduler, resumeInterruptedTurns } from "./agent/turn-resume.js";
import { startWatchers } from "./agent/watchers.js";
import { resumeWorkflowExecution } from "./workflows/workflow-runner.js";
import { createAutomationsScheduler } from "./automations/scheduler.js";
import { emitWorkspaceEvent } from "./automations/workspace-events.js";
import { sweepAgedState, sweepStateAtBoot } from "./workspace/state-janitor.js";
import { stateRelPath } from "./workspace/state-paths.js";
import { capabilityCtx } from "./capabilities/capability.js";
import { restoreConnectorHooks } from "./capabilities/cli/connector-hooks.js";
import { linkSshHosts } from "./capabilities/ssh-hosts.js";
import { startTranslator } from "./agent/translator.js";
import { onPath } from "./platform/on-path.js";
import { DOCKER_PANEL_KEY, startDockerdIfEnabled } from "./capabilities/handlers/docker.js";
import { localModelPanelKey, startLocalModelsIfEnabled } from "./capabilities/handlers/localmodel.js";
import { writeAgentToken } from "./auth/agent-token.js";
import { createCiPoller } from "./ci/poller.js";
import { restoreExits } from "./exit/exit-links.js";
import { reconnectVpns } from "./vpn/vpn-links.js";
import { AGENT_SIGNALS_DIR, watchDelegationSignals } from "./agent/delegation-signals.js";
import { startProviderBoot } from "./agent/provider-registry.js";
import { createServices } from "./composition.js";
import { draftsPublisherFor } from "./drafts/drafts-publisher.js";
import { ensureDraftsSkill } from "./drafts/drafts-store.js";
import { startAllExtensionProcesses } from "./extensions/extension-processes.js";
import { startExtensionUpdateWatch } from "./extensions/extension-updates.js";
import { runGitMaintenance } from "./git/maintenance.js";
import { prepushCheck } from "./prepush/prepush.js";
import { ensureRepoGitDirs } from "./git/repo-git-dirs.js";
import { commitRootBaseline, ensureLocalRootRepo, ensureRootRepo } from "./git/root-repo.js";
import { reconcileSkills } from "./settings/skills.js";
import { composeEnvironment } from "./environment/environment.js";
import { sweepStaleExports } from "./portability/exports.js";
import { queueVerify, type VerifyDeps } from "./workspace/verify-deps.js";
import { type Config, loadConfig } from "./env.config.js";
import { createLogger } from "./logger.js";
import { applyTmuxLogHooks, logsRoot, pruneLogFiles, terminalLogsDir } from "./logs/log-files.js";
import { applyEventsPath, applyRunLive } from "./intentic/apply-events.js";
import { checkEventsDir } from "./intentic/check-run.js";
import { INFRA_APPLY_KEY } from "./intentic/infra-apply.js";
import { killStaleManagedSessions, panelSession } from "./processes/managed-processes.js";
import { createPreviewProxy } from "./panels/preview-proxy.js";
import { ensureAllPreviewRoutes } from "./panels/preview-route.js";
import { publicRoot } from "./public/public-files.js";
import { createPublicHandler } from "./public/public-serve.js";
import { linkClaudeState } from "./sessions/session-store.js";
import type { BootTracker } from "./platform/boot.js";
import { claimBootMarker } from "./platform/boot-marker.js";
import { claimContainer } from "./platform/container-owner.js";
import { checks as containerChecks, owner as containerOwner } from "./platform/invariant.js";
import { listenHost, profileTraits, requireLocalContract } from "./platform/profile.js";
import { startLoopWatchdog } from "./platform/loop-watchdog.js";
import { startIdleStop } from "./system/idle-stop.js";
import { startResourceMetrics } from "./platform/resource-metrics.js";
import { startWorkloadPriorityGovernor } from "./platform/workload-priority.js";
import { onTurnSettled, turnRunMetrics } from "./agent/turn-runs.js";
import { browserSessionMetrics } from "./browser/browser-sessions.js";
import { readLocalCertificate, startLocalCertificateRenewal } from "./platform/local-cert.js";
import { restoreAuthorizedKeys, seedPairing } from "./platform/sync.js";
import { seedSetupHost } from "./hosts/host-seed.js";
import { seedStarterSite } from "./scaffold/starter-site.js";
import { reapFinishedSessions } from "./terminal/terminal-session.js";
import { startVersionCheck } from "./platform/version-check.js";
import { recordNewestRun } from "./store/newest-run.js";
import { startReleaseNotesCheck } from "./platform/release-notes.js";
import { startRuntimeHealth } from "./agent/adapter-health.js";
import { startRepoWatch, subscribeRepoChanges } from "./workspace/repo-watch.js";
import { startRefWatch } from "./git/ref-watch.js";
import { startWorkspaceWatch, subscribeWorkspaceChanges } from "./workspace/workspace-watch.js";

// The sandbox container's entrypoint. Config comes from env set at `docker run`, by connect.sh (your PC) or
// the workspace provider (a server); the workspace (the repos) and agent credentials are injected there,
// never baked in.
//
// LISTEN FIRST, CONVERGE BEHIND THE GATE. The boot chain below (state links, git-dir healing, the registry
// load) used to run before serve(), so every daemon death cost its crash PLUS a couple of minutes of
// connection-refused while sweeps re-walked a fleet of worktrees, the browser sat on the reconnect screen
// for all of it. The listeners now come up immediately: /health and /events answer at once (the UI paints,
// heartbeats flow), and every data route waits on the readiness gate (app.ts), which resolves when the chain
// finishes, the same ordering guarantees, minus the outage.
//
// The chain NAMES ITSELF, in the table below. Every awaited step is declared here before any of it runs, so
// /health and /events can report which one is in flight and how far along the boot is, the browser holds its
// reads and shows the wait rather than painting an operable workspace over a daemon that answers nothing (see
// platform/boot.ts). A step added below without an entry here does not compile: the `boot` alias in main() is
// narrowed to these keys, so an undeclared one is a type error rather than a throw that strands the gate shut.
const BOOT_STEPS = [
    { key: "authorizedKeys", label: "Restoring desktop enrollments" },
    { key: "claudeState", label: "Linking conversation state" },
    { key: "sshHosts", label: "Linking ssh hosts" },
    { key: "vaultSecrets", label: "Securing stored credentials" },
    { key: "rootRepo", label: "Preparing the workspace repo" },
    { key: "starterSite", label: "Putting your starter site in place" },
    { key: "referenceShelf", label: "Ensuring the reference shelf" },
    { key: "staleExports", label: "Sweeping interrupted exports" },
    { key: "repoGitDirs", label: "Healing repository git dirs" },
    { key: "agentsRegistry", label: "Loading conversations" },
    { key: "skills", label: "Converging agent skills" },
    { key: "baseline", label: "Taking the workspace baseline" },
    { key: "staleSessions", label: "Sweeping stale sessions" },
    { key: "agentToken", label: "Writing the agent token" },
] as const;

/* THE ONE SWITCH THAT MUST NOT FAIL OPEN.
 *
 * `google.clientId` is what builds the authorizer (composition.ts). Empty is a legitimate mode, the tests and
 * the host-internal server preview run loopback with no auth at all, but it is legitimate only for a daemon
 * nothing outside can reach. Set it empty on a daemon that HAS a tunnel and every gate in app.ts disappears at
 * once: no bearer middleware, `ownerDenied` answers "you are the owner", /enroll takes any caller, and
 * /system/terminal hands out a root PTY. Nothing in the logs distinguishes that from a healthy boot.
 *
 * A connect token or a public URL is the daemon saying it is reachable from outside, so the two together are
 * the contradiction: refuse to serve rather than serve everything. Dying here costs a misconfigured sandbox a
 * restart loop with the reason in its logs, which is the failure everyone wants over the silent one.
 *
 * SANDBOX_ALLOW_UNAUTHENTICATED is the single acknowledged exception, and it is loud rather than quiet: the e2e
 * tiers need a connect token (nothing else derives a sync ssh hostname) on a daemon they drive with no
 * credential, which no amount of inference can distinguish from the misconfiguration above, so the harness
 * says it in the container env and the daemon repeats it in `docker logs` on every boot. env.config.ts carries
 * the full note, including the caller list it must stay at. */
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

// A workspace-relative path that is extension SOURCE, the three places a backend extension's code or its
// enablement can arrive from. Module scope so the watcher's callback doesn't rebuild it on every change batch.
const extensionSource = (path: string): boolean =>
    path.startsWith(`${stateRelPath(".intentic/config/workspace-extensions/")}/`) ||
    path.startsWith(`${stateRelPath(".intentic/local/extensions/")}/`) ||
    path === stateRelPath(".intentic/config/extension-enablement.json");

const main = async (): Promise<void> => {
    const config = loadConfig();
    requireAuthWhenReachable(config);
    requireLocalContract(config);
    // Every profile difference below reads a named trait, never the profile value, see platform/profile.ts.
    const traits = profileTraits(config);
    const host = listenHost(config);
    if (!traits.sharedTmux) {
        // No tmux server of our own to wrap agent shell commands into, the existing env contract the Bash
        // rewrite honors (agent-terminals.ts), defaulted rather than forced so an operator can still override.
        process.env["INTENTIC_AGENT_TMUX"] ??= "0";
    }
    // Every intentic CLI run spawned in here (the /intentic routes, the panel-infra-apply tmux session) tees
    // its output to the daemon-owned logs tree, the same INTENTIC_LOG_DIR contract as an operator shell.
    process.env["INTENTIC_LOG_DIR"] ??= join(logsRoot(config.historyRoot), "intentic-runs");
    // The agent env spreads process.env (agent.ts baseOptions), so bin/tmux-run and the output filter
    // inherit where the pipe-pane hooks persist raw pane logs, the filter footer's escape hatch.
    process.env["INTENTIC_TERMINAL_LOGS_DIR"] ??= terminalLogsDir(config.historyRoot);
    const logger = createLogger(config);
    // ponytail: log-and-continue, don't exit. The daemon's whole job is to stay up for /agent + /events; a
    // rejected best-effort boot job (the void reconnectVpns/composeEnvironment/ensureAllPreviewRoutes/… below)
    // must not take the origin down. A genuinely fatal state is rare, and --restart unless-stopped still
    // catches a hard crash. The pre-logger config-load throw stays unguarded, a bad config should crash loudly.
    process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled rejection"));
    process.on("uncaughtException", (err) => logger.error({ err }, "uncaught exception"));
    // Death forensics: name the previous run's unannounced death (with its fatal report, when V8 wrote one)
    // and stamp this run's marker; the exit hook below is what flips it to "exited" on every deliberate path.
    // Skipped without a history volume (dev, tests), same opt-out as the file log destination.
    if (config.historyRoot !== "") {
        const bootMarker = claimBootMarker(logsRoot(config.historyRoot), logger);
        process.on("exit", (code) => bootMarker.markExited(code));
    }
    /* EVERYTHING THIS DAEMON HAS TO PUT DOWN, collected where it is picked up.
     *
     * This was twenty-five `.stop()` calls in a row at the bottom of this file, and nothing connected that list
     * to the subsystems it covered: adding a watcher, a poller or an interval meant remembering to add a line,
     * and forgetting cost nothing visible, the process was exiting anyway. A missed stop only ever showed up
     * where it actually hurts, in the tests and the long-lived dev sandbox, as a handle keeping the event loop
     * alive or a timer firing against a service that is already gone.
     *
     * Registering next to the creation is the whole fix: the line that starts a thing and the line that stops
     * it are one line apart, so the two cannot drift, and shutdown below has nothing left to enumerate. */
    const shutdown = new DisposableStore();
    // The stall detector: any future freeze, a synchronous path in here, or the whole VM thrashing under a
    // fleet of builds, leaves a log line with the lag and the machine's pressure numbers attributing it.
    const loopWatchdog = startLoopWatchdog(logger);
    shutdown.push(() => loopWatchdog.stop());
    // Provider SDKs spawn their CLIs internally, outside the polite Bash/git wrappers. Keep every direct child
    // below the control plane so a newly introduced workload cannot compete equally with /events heartbeats.
    const workloadPriority = startWorkloadPriorityGovernor();
    shutdown.push(() => workloadPriority.stop());
    const services = createServices(config, logger);
    shutdown.push(() => services.perf.stop());
    shutdown.push(() => services.ciHooks.stop());
    shutdown.push(() => services.announcer.stop());
    shutdown.push(() => services.reach.stop());
    shutdown.push(() => services.history.stop());
    // Stops the extension gateway processes too (tmux kill-session ⇒ SIGHUP), each flushes its own in-flight
    // voice transcript on the way down.
    shutdown.push(() => services.processes.stopAll());
    // The backend host is a direct child, not a tmux session, stopped here or it outlives the daemon.
    shutdown.push(() => services.extensionBackend.stop());
    /* AM I THIS SANDBOX'S DAEMON, OR A RUN OF ITS CODE, asked before anything is claimed, swept or announced,
     * because every one of those is container-wide and a container can hold more than one of us. This repository
     * IS the daemon: agents working in it start one from source to watch a change work, and twice on 2026-08-11
     * that second daemon's first sweep killed every turn the live one had in flight. A guest serves its own
     * routes and owns nothing that was here before it, see platform/container-owner.ts for the whole list and
     * the two days that wrote it.
     *
     * The LOCAL profile never asks: the claim file lives in HOME, which is the user's and not this daemon's to
     * touch, and there is no container to own, each local engine has its own roots and every container-wide
     * surface the `container` role gates is off in this profile by design. Its role is pinned instead of
     * derived, which is also what keeps a local engine that happens to be alone on a machine from claiming
     * "the container" and waking furniture the local posture promises never to run. */
    const role = traits.convergeHome
        ? await claimContainer({ workspaceRoot: config.workspaceRoot, historyRoot: config.historyRoot }, logger)
        : { container: false, roots: true };
    /* The last invariant companion, wired here rather than in composition because its subject is the answer just
     * computed: everything downstream trusts this role forever, and the claim it rests on is a file a second
     * daemon's boot overwrites (platform/invariant.ts). */
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
            // The one place a broken promise is visible without reading the log: the durable resource series
            // already runs every minute and is already where "what is this daemon holding" is answered.
            invariants: { violations: services.invariants.violations().length },
        }),
    });
    shutdown.push(() => resourceMetrics.stop());
    /* Point the scaffold's git seam at the perf tracker, so every git this daemon runs, the Changes scan's
     * hundreds of reads, a land's checkout, the history snapshots, is attributable. Git is where the reported
     * slowness lives and it was the one subsystem with no measurement at all.
     *
     * `dir` is trimmed to a workspace-relative name: absolute paths make every line wrap and the prefix is the
     * same on all of them. `args` keeps the subcommand and its flags but drops trailing operands, which are
     * pathspecs, a `checkout -- <400 paths>` would otherwise put 400 paths in a log line, and the subcommand
     * is what identifies the op anyway. */
    observeGitCommands(({ dir, args, ms, execMs, attempts, failed, forked, queueDepth }) => {
        const fields = {
            git: args.slice(0, 3).join(" "),
            repo: dir.startsWith(services.workspace.root) ? dir.slice(services.workspace.root.length + 1) || "root" : dir,
            ...(attempts > 1 ? { lockRetries: attempts - 1 } : {}),
            // Only worth a field when it is FALSE: a direct exec pays the parent's page-table copy on every
            // call (~27ms at this daemon's resident size), which is a whole class of slowness on its own.
            ...(forked ? {} : { forked: false }),
            ...(queueDepth > 0 ? { queueDepth } : {}),
        };
        services.perf.record("git.run", ms, { ...fields, execMs: Math.round(execMs) }, failed);
        /* AND THE PART THAT WASN'T GIT, filed as its own op so the ranked summary carries both numbers side by
         * side. `git.run` alone is the measurement that sent a performance review after the repo layer: it read
         * "86,070 calls, mean 77ms" and concluded git was slow, when the same commands are 1-9ms at a shell and
         * the difference is this process's event loop being away (p99 stall 10s, max 239s). One glance at the
         * two rows now says which subsystem to open. Never negative: the two clocks are read on opposite sides
         * of an IPC hop, so a sub-millisecond call can report a hair more exec than wall. */
        services.perf.record("git.run.wait", Math.max(0, ms - execMs), fields, failed);
    });

    /* Every provider's boot tasks — the Codex config write, Cursor's command-gate socket, Claude's refresh
     * timers, the OpenCode warm-up — declared by each provider's own module and iterated here
     * (agent/provider-registry.ts). One loop instead of four blocks scattered through this function, so a new
     * provider's boot is a field on its module rather than a block a reviewer has to find the right place for.
     * Each task is fire-and-forget and best-effort by the seam's contract: a provider that cannot start is its
     * own log line, never a failed daemon. */
    startProviderBoot(services, role, logger);

    // The other end of those hooks: fold what delegated CLIs report (their session id, blocked, their last
    // words) into the subagent roster. Best-effort like the config write above, a sandbox without the spool
    // still settles every delegation through the Bash result path.
    // The spool is one fixed container path, so a second watcher would fold every signal onto two rosters.
    if (role.container) {
        void watchDelegationSignals(AGENT_SIGNALS_DIR, (error: unknown) => logger.warn({ err: error }, "delegation signal dropped")).catch(
            (error: unknown) => logger.warn({ err: error }, "delegation signals not watched"),
        );
    }

    // Setup-time desktop sync: arm the platform-minted pairing token so the connect script can enroll its agent.
    // No-op once that token has been redeemed, the burn is recorded on /history, so the copy living in the
    // container's env cannot be replayed by a restart (see seedPairing). Detached: the connect script's agent
    // retries its enroll, so nothing here needs to hold the boot.
    if (config.syncPairToken !== "") {
        void seedPairing(config.historyRoot, config.syncPairToken).catch((error: unknown) =>
            logger.warn({ err: error }, "setup pairing not armed, enable desktop sync from the browser instead"),
        );
    }

    /* Setup-time CONNECTED COMPUTER: create the card for the machine that ran the installer and arm its pairing,
     * so the agent that same flow installed can enroll. A no-op on every boot after the first, the token is
     * burned on /history when it is redeemed, and on every sandbox that was set up before this existed.
     *
     * Detached like the sync seed above: the machine agent retries its enroll on its own backoff, so nothing here
     * needs to hold the boot. A failure leaves the computer unconnected and the Computers view saying so, which
     * is exactly what it said before this existed. */
    if (config.hostPairToken !== "") {
        void seedSetupHost(services, { token: config.hostPairToken, platform: config.hostPlatform, label: config.hostLabel })
            .then(({ armed, id }) => {
                if (armed) {
                    logger.info({ host: id }, "setup computer armed: it may manage this machine's sandboxes; widen or revoke on its capability card");
                }
            })
            .catch((error: unknown) =>
                logger.warn({ err: error }, "setup computer not connected, add it from Capabilities to manage this machine's sandboxes"),
            );
    }

    // Close the readiness gate the data routes await (app.ts) and name what it is waiting for. A request that
    // arrives early WAITS a few seconds instead of reading half-built state; a browser that arrives early is
    // told which step is running and holds its reads until the last one lands.
    services.boot.declare(BOOT_STEPS);

    const app = createApp(services);
    // The interactive-terminal WebSocket (/system/terminal) rides node-server's native WS support: `ws` in
    // noServer mode handles the upgrade, node-server routes it through Hono's upgradeWebSocket to the terminal.
    // `ws`'s WebSocketServer types its options.noServer as `boolean | undefined`; node-server's WebSocketServerLike
    // wants a plain boolean under exactOptionalPropertyTypes. The shapes match at runtime, assert the interface.
    const terminalSockets = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    const server = serve({ fetch: app.fetch, port: config.sandbox.port, hostname: host, websocket: { server: terminalSockets } });
    shutdown.push(() => server.close());
    logger.info(
        { host, port: config.sandbox.port, workspace: config.workspaceRoot, profile: config.sandbox.profile },
        "intentic sandbox daemon listening",
    );

    /* THE LOOPBACK LISTENER, the same app on a second port, and the only one ever published to the host, so a
     * browser on this machine reaches the daemon directly instead of crossing to a Cloudflare edge and back.
     *
     * A second listener rather than TLS on the one above, because the two ports answer to different callers:
     * the tunnel connector dials this daemon in plain HTTP over the container network and would break the
     * moment 8787 spoke TLS, while the browser needs TLS or Safari refuses the address as mixed content.
     *
     * The certificate is whatever is already on disk, issuance is a CA validating DNS, far slower than a boot
     * should wait, so it happens in the background and lands at the next restart. Without one the listener
     * serves plain HTTP, which Chrome and Firefox still accept for loopback; the browser probes both and the
     * daemon's identity decides. Its own WebSocket server: `ws` in noServer mode is bound to one HTTP server,
     * so sharing the instance above would leave terminals on this port unupgradeable.
     *
     * HTTP/2, and that is not a performance nicety, it is what stops the workspace freezing. A browser allows
     * SIX concurrent HTTP/1.1 connections per origin, and this app holds LONG-LIVED ones: `/events` forever,
     * plus an `/agent/attach` for every conversation with a live turn (plus `/intentic/apply/events`, plus any
     * popped-out window, all sharing the one origin). Four or five running agents therefore consume every slot,
     * and the next request, any ordinary read, has nowhere to go and simply queues in the browser until a
     * stream ends. Nothing is wrong daemon-side, which is exactly why it presents as "the sandbox froze" with a
     * silent, healthy log; only dropping the sockets (a reload of every tab, or clearing site data) frees it.
     * One h2 connection carries ~100 concurrent streams instead, so the cap stops binding at any realistic
     * number of agents.
     *
     * `allowHTTP1` is required rather than tidy: WebSocket has no h2 form here (Node does not advertise the
     * extended-CONNECT setting RFC 8441 needs), so the browser opens a SEPARATE http/1.1 connection for the
     * terminal, which this accepts, and whose `upgrade` event still reaches the `ws` server above. It is also
     * the fallback for any client that does not do ALPN at all. */
    const localCertificate = traits.extraListeners ? readLocalCertificate(config) : undefined;
    const localSockets = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    // A tunnel-avoiding shortcut is meaningless when the ONLY listener is already loopback, the local
    // profile serves one plain port and nothing else (traits.extraListeners).
    const localServer = !traits.extraListeners
        ? undefined
        : serve({
              fetch: app.fetch,
              port: config.local.port,
              hostname: host,
              websocket: { server: localSockets },
              ...(localCertificate === undefined
                  ? {}
                  : {
                        createServer: createSecureServer,
                        serverOptions: {
                            cert: localCertificate.certificate,
                            key: localCertificate.privateKey,
                            allowHTTP1: true,
                            // Node's default session memory (10MB) is a budget shared by every stream on the
                            // connection, which is now ALL of them, including transcript replays that arrive in
                            // multi-megabyte bursts. Exceeding it kills the session, i.e. the whole workspace's
                            // connection at once, so the ceiling has to be sized for the multiplexing this enables.
                            maxSessionMemory: 128,
                        },
                    }),
          });
    shutdown.push(() => localServer?.close());
    if (localServer !== undefined) {
        logger.info(
            { port: config.local.port, tls: localCertificate !== undefined, hostname: localCertificate?.hostname },
            "loopback listener ready",
        );
    }
    // Obtain/renew in the background. Never rejects: a sandbox with no certificate is a working sandbox.
    const localCertRenewal = role.container && traits.extraListeners ? startLocalCertificateRenewal(config, logger) : undefined;
    shutdown.push(() => localCertRenewal?.stop());

    // The preview proxy: preview-<panel>-<id>.<zone>, port-<slot>-<id>.<zone> and public-<slot>-<id>.<zone>
    // land here (the tunnel's fixed origin) and the Host header's first label routes to the panel's running
    // port, the slot's forwarded port, or the workspace's outbox. Always listening, with nothing up it answers
    // 502, not connection-refused. Everything it serves is public, no owner-gating.
    //
    // The outbox needs the connect token for its salted slot, so a token-less daemon (tests, loopback) simply
    // has no address to publish at. The handler is bound to public/ whether or not that directory exists: the
    // dir's existence is the switch, and it is checked per request, so `mkdir public` starts publishing without
    // a restart and `rm -rf public` stops it just as immediately.
    const previewProxy = !traits.extraListeners
        ? undefined
        : createPreviewProxy({
              panelOf: services.panelUpstreamOf,
              slotTargetOf: services.portForwards.targetOf,
              sandboxId: sandboxIdFromToken(config.connectToken),
              outbox:
                  config.connectToken === ""
                      ? undefined
                      : { slot: publicSlotFromToken(config.connectToken), serve: createPublicHandler(publicRoot(config.workspaceRoot)) },
          });
    previewProxy?.listen(config.preview.port, host);
    shutdown.push(() => previewProxy?.close());

    // Phone home: announce this sandbox's URL to the platform registry (once per boot, retried until acked,
    // see platform/announce.ts), so the setup wizard sees it come online without any browser→sandbox probing.
    // Needs all three env values, headless/test runs without them just don't announce. Started with the
    // listeners, not after the boot chain: the announcement is how a waiting browser learns the daemon is
    // back, and it must not queue behind the very sweeps it would be reporting through.
    if (config.platform.url !== "" && config.sandbox.publicUrl !== "" && config.connectToken !== "") {
        if (role.container) {
            services.announcer.start();
            /* And immediately: does that public URL actually answer? Started here rather than after the boot
             * chain for the same reason the announce is, a waiting browser is reading exactly this, and it
             * has to hear "checking" while the tunnel comes up rather than nothing at all. The two are
             * separate claims deliberately (see reach-report.ts); registering says the daemon exists,
             * this says somebody can get to it. */
            services.reach.start();
        }
    }

    // The hosted flavor's idle-stop (system/idle-stop.ts): after the configured quiet window, nobody
    // connected, no turn, no live delegate, no terminal saying anything, the daemon takes the graceful exit
    // so its machine can stop; the platform starts it again on the next visit. 0 (every non-hosted flavor)
    // means always-on, exactly as before.
    if (config.idleStopMinutes > 0 && role.container) {
        shutdown.push(startIdleStop({ minutes: config.idleStopMinutes, logger }));
    }

    /* Ask the platform whether this sandbox gets a free trial, and how much of today's allowance is left. The
     * answer IS the trial endpoint's existence (trial/trial-endpoint.ts), so this runs beside the announce
     * rather than inside the boot chain: a user whose first act is to open the chat must find the trial already
     * there, not appear a sweep later. Unawaited and self-swallowing, a platform that never answers leaves the
     * sandbox with no trial, which is the failure that costs the user nothing. */
    if (role.container) {
        void services.trial.refresh();
    }

    // Every awaited step below runs through the tracker: it stamps the step's state and elapsed time, logs the
    // slow ones (a boot that takes minutes has ONE slow step, and until it is named every slow boot reads as
    // "the daemon is just slow"), and streams the transition to whatever browser is watching. Narrowed to the
    // declared keys so the table above is enforced at compile time, a step whose entry someone forgot used to
    // throw on its first run, which aborts the chain, leaves the gate shut forever and reads to the user as a
    // browser stuck on the boot screen behind a daemon whose log says only "unhandled rejection".
    const boot: BootTracker<(typeof BOOT_STEPS)[number]["key"]> = services.boot;

    // ~/.ssh and ~/.claude are the CONTAINER's filesystem, shared by every process in it, so the jobs below that
    // converge them onto THIS run's roots (the three steps here, plus the git-access restore further down) run
    // only for the daemon that owns the container. A second daemon started in here, a dev run rooted under /tmp
    //, would otherwise repoint the live daemon's git keys and conversation state at its own empty roots, and
    // nothing would notice until a push was refused: see platform/container-owner.ts for the day that happened.
    const ownsHome = role.container;

    // Desktop enrollments live on /history and outlive the container; the authorized_keys sshd reads does NOT
    // (it is ~/.ssh, container-local), so re-derive it from the store before sshd serves a laptop's first
    // reconnect. Ordered before the gate resolves, a rebuild otherwise leaves every enrollment valid but unauthorized.
    await boot.step("authorizedKeys", async () => {
        if (!ownsHome) {
            return;
        }
        await restoreAuthorizedKeys(config.historyRoot).catch((error: unknown) =>
            logger.warn({ err: error }, "authorized_keys not restored, enrolled machines will be refused until they re-enroll"),
        );
    });

    // Claude conversation state (transcripts, plans, backups, task outputs, todos) lives under the SDK's
    // ~/.claude, ephemeral container fs. Converge every store onto /work BEFORE the gate opens (turns wait on
    // it, so the CLI can never race this). Awaited, unlike the best-effort steps below, because a turn
    // spawning the CLI mid-link would fork stores.
    await boot.step("claudeState", async () => {
        if (!ownsHome) {
            return;
        }
        await linkClaudeState(services.workspace.root).catch((error: unknown) =>
            logger.warn({ err: error }, "claude session state not persisted, sessions will not survive a rebuild whole"),
        );
    });

    // The managed ssh dir (git-provider keys + every ssh capability's key) is the other store that lived in the
    // container's ephemeral HOME, point it at the /history volume before anything reads or writes an alias, so
    // a recreate stops silently taking git access and the ssh machines down with it. Awaited for that ordering;
    // a failure (a dev-host run, where the guard refuses to touch a real ~/.ssh/intentic-hosts) leaves the
    // pre-existing local dir in place rather than the daemon down.
    await boot.step("sshHosts", async () => {
        if (!ownsHome) {
            return;
        }
        await linkSshHosts(config.historyRoot).catch((error: unknown) =>
            logger.warn({ err: error }, "ssh hosts dir not persisted, git access and ssh aliases will not survive a rebuild"),
        );
    });

    /* The capability manifest is meant to be readable and editable by the agent, so the credential VALUES are
     * kept out of it and in a store off /work. Only a SAVE moves them, though, which leaves every service
     * connected before the split, and any entry the agent pasted a real token back into, sitting in a file a
     * plain Read hands to the model. Sweep them in before the gate opens, so no turn can read the file first.
     * Best-effort: a manifest this daemon cannot rewrite is a warning, never a boot failure. */
    await boot.step("vaultSecrets", async () => {
        const moved = await services.vaultManifestSecrets().catch((error: unknown) => {
            logger.warn({ err: error }, "capability credentials: could not be moved out of the manifest, they stay readable to the agent");
            return [];
        });
        if (moved.length > 0) {
            logger.info({ capabilities: moved }, "capability credentials moved out of the workspace manifest into the private store");
        }
        /* The same sweep for extension settings, in the same step because it is the same guarantee: a value an
         * extension declared `secret` must not be sitting in a file a turn can Read. It matters more here, and
         * that is why it runs before the gate rather than lazily, the settings file is TRACKED, so an unswept
         * token would not merely be readable, it would be committed. */
        const settings = await services.vaultExtensionSettingSecrets().catch((error: unknown) => {
            logger.warn({ err: error }, "extension setting secrets: could not be moved out of the tracked file, they stay readable to the agent");
            return [];
        });
        if (settings.length > 0) {
            logger.info({ extensions: settings }, "extension setting secrets moved out of the tracked settings file into the private store");
        }
    });

    // The /work workspace repo (the Changes review's "root"): init once, heal the .git pointer, converge
    // excludes. Awaited (cheap, and the git routes assume it), but a failure must not take the daemon down, a
    // failure reads as "not fresh" so we skip the baseline commit below.
    // Local roots are the user's own folder: taken as they stand, never reshaped, see ensureLocalRootRepo.
    const freshRoot = await boot.step("rootRepo", async () =>
        !role.roots
            ? false
            : (traits.relocateGitDirs ? ensureRootRepo(services.workspace, config.historyRoot) : ensureLocalRootRepo(services.workspace)).catch(
                  (error: unknown) => {
                      logger.warn({ err: error }, "root workspace repo not ensured, the Changes review will degrade");
                      return false;
                  },
              ),
    );

    /* THE STARTER SITE, on a fresh workspace only: the baked one-page site copied in and its dev server
     * started, so the first screen a new user sees has something of theirs running on it (scaffold/starter-site.ts).
     *
     * Awaited, and BEFORE the baseline commit: the seed creates a nested repo, and root's excludes and its
     * "Initialize workspace" commit both have to be taken with that repo already on disk, or the starter's
     * files surface as a phantom add in the Changes review. It costs a fresh boot one file copy and nothing at
     * all on every later boot; a failure is logged and the sandbox opens with an empty workspace, exactly as it
     * did before this existed. */
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
        /* A SKIP SAYS WHY, and only here. The gate above already narrowed this to the first boot of a workspace
         * the daemon owns, so this is one line on the one boot that was supposed to seed, not noise on every
         * later start. It is worth the line because the evidence is otherwise gone: the boot happens once, and
         * a sandbox that opened empty because of a wrong verdict looks identical to one that opened empty
         * because the user brought their own code. */
        logger.info({ why: outcome.skipped }, "starter site not seeded, the workspace opens as it arrived");
    });

    // The reference shelf (REFERENCE_DIR, @intentic/workspace-ignore): furniture, like .intentic, its presence
    // IS the affordance. Every scanner already excludes it; without the dir on disk the convention is invisible
    // (nothing to drop onto, nothing in the tree to explain itself). Idempotent, so a shelf deleted mid-session
    // stays gone until the next boot re-ensures an empty one.
    // ownsWorkspaceConfig beside role.roots: the shelf convention is workspace furniture, not the daemon's
    // to place in a folder it doesn't own. A local agent asked to fetch a reference creates the dir then.
    await boot.step("referenceShelf", async () =>
        !role.roots || !traits.ownsWorkspaceConfig
            ? undefined
            : mkdir(join(config.workspaceRoot, REFERENCE_DIR), { recursive: true }).catch((error: unknown) =>
                  logger.warn({ err: error }, "reference shelf not ensured, refs/ drops have no target"),
              ),
    );

    // An environment export half-written when the daemon stopped. Only a LIVE process can be writing a `.part`,
    // so one that survived a restart is an export that will never finish, marked failed here so the card shows
    // a reason instead of a progress bar that never moves again (portability/exports.ts).
    await boot.step("staleExports", async () =>
        !role.roots
            ? undefined
            : sweepStaleExports(config.historyRoot).catch((error: unknown) =>
                  logger.warn({ err: error }, "stale exports not swept, an interrupted export may still read as packing"),
              ),
    );

    // No repo keeps its git dir under /work: a worktree's gitdir pointer has to resolve identically inside an
    // isolated turn's namespace, where /work IS that worktree (agents/isolation.ts). Every daemon-created repo
    // is already shaped this way; this converges the ones that arrived by other roads. After ensureRootRepo,
    // whose excludes it does not disturb, and before the registry loads the worktrees it repairs.
    // relocateGitDirs beside role.roots: the out-of-tree shape serves namespace isolation, which local never
    // builds, and locally the repos are the user's own, not the daemon's to reshape.
    await boot.step("repoGitDirs", async () =>
        role.roots && traits.relocateGitDirs ? ensureRepoGitDirs(services.workspace, config.historyRoot, logger) : undefined,
    );

    // The fleet registry: load persisted conversations and broadcast the roster (an /events stream opened
    // during boot is already holding an empty fleet). Awaited, the /agents routes assume a loaded registry,
    // but a failure degrades to an empty fleet, never a dead daemon. The worktree sweeps run DETACHED below.
    await boot.step("agentsRegistry", () =>
        services.agents.init().catch((error: unknown) => logger.warn({ err: error }, "agents registry not initialized, the fleet starts empty")),
    );

    // Converge the daemon-owned /work skill files BEFORE the baseline commit so a fresh sandbox reads clean
    // instead of surfacing them as a phantom add. Awaited for exactly that ordering; still log-and-continue, and
    // on a non-fresh boot (no baseline) their writes become ordinary pending changes for the Changes review.
    // - the drafts skill: how the agent writes post drafts for approval, so its prose tracks the daemon.
    // - the baked-tool skills, per the settings `skills` list, each present only when named (the CLIs are
    //   always on PATH; the skill file is what surfaces one to the agent).
    await boot.step("skills", async () => {
        // ownsWorkspaceConfig beside role.roots: a folder the daemon doesn't own gets no unasked-for writes
        // (or deletes) under .agents/skills, and the baked-tool skills teach container-only CLIs anyway.
        if (!role.roots || !traits.ownsWorkspaceConfig) {
            return;
        }
        await ensureDraftsSkill(services).catch((error: unknown) => logger.warn({ err: error }, "drafts skill not converged"));
        await services.sandboxSettings
            .get()
            .then((settings) => reconcileSkills(services, settings.skills))
            .catch((error: unknown) => logger.warn({ err: error }, "skill reconcile failed"));
    });

    // Baseline "Initialize workspace" commit, taken once on a fresh sandbox now that the daemon's /work-owned
    // files exist, so the Changes review starts with zero pending changes.
    await boot.step("baseline", async () => {
        if (freshRoot) {
            await commitRootBaseline(services.workspace).catch((error: unknown) =>
                logger.warn({ err: error }, "root baseline commit failed, the Changes review will start dirty"),
            );
        }
    });

    // Panel/agent/job tmux sessions outlive a daemon restart (the tmux server is container-scoped), kill
    // leftovers so "panels are stopped after a restart" holds and no orphan dev server squats an untracked
    // port. EXCEPT a live infra apply (killing it would truncate the host mutation mid-run, orphan the host
    // apply lock for its TTL, and report the run complete, when the event log records a started-but-not-exited
    // run and its session survives, re-adopt it; the web reattaches through the same event log) and a live
    // dockerd (panel-docker keeps serving containers across daemon restarts, adopt it back). The sweep is
    // ORDERED before the gate opens so the capability restores below can't race a kill of the session they
    // just started.
    await boot.step("staleSessions", async () => {
        // Container-wide: the tmux server is shared, so these sessions belong to whoever owns the container.
        if (!role.container) {
            return;
        }
        const applyLive =
            (await applyRunLive(applyEventsPath(config.historyRoot)).catch(() => false)) &&
            (await services.processes.adopt(INFRA_APPLY_KEY, { oneShot: true }).catch(() => false));
        const dockerAlive = await services.processes.adopt(DOCKER_PANEL_KEY, {}).catch(() => false);
        // A live llama-server is adopted for the dockerd reason, with a heavier price for getting it wrong:
        // killing one throws away a loaded model, and reloading a large one costs minutes of dead picker.
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
    });
    // A previous boot's check runs left per-run event files behind (their streams died with the daemon).
    if (role.roots) {
        void rm(checkEventsDir(config.historyRoot), { recursive: true, force: true });
    }

    // The in-container `vpn` CLI reads this to reach the daemon's /vpn routes; written before the restores
    // below so a tunnel the agent dials during boot already has a token to present.
    await boot.step("agentToken", async () => {
        // The token file lives at a fixed container path (/run) for the in-container vpn/otp CLIs, container
        // furniture a local daemon has neither the path nor the callers for.
        if (!traits.containerCapabilities) {
            return;
        }
        await writeAgentToken(services.agentToken).catch((error: unknown) => services.logger.warn({ err: error }, "agent token: could not write"));
    });

    /* Reserve dependency maintenance before the data gate opens. The workspace watcher itself starts below,
     * but its subscriber set is intentionally usable before then; registering now also starts the boot scan.
     * A turn arriving the instant boot finishes therefore queues behind an already-reserved repair instead of
     * becoming the race that discovers the stale tree. */
    const dependencyChecks: VerifyDeps = {
        workspace: services.workspace,
        processes: services.processes,
        logger: services.logger,
        verifyStore: services.verifyStore,
        activity: services.activity,
        emit: (event) => emitWorkspaceEvent(services, event, streamAgent),
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

    // The state the data routes serve is converged, open the gate. Everything below is background machinery
    // that no queued request depends on.
    boot.finish();

    /* THE PROMISES THIS DAEMON MAKES TO ITSELF (invariants/), driven from here because this is the file that
     * knows the moments. Detached and never awaited: a check is a diagnostic, and a boot that waited on one
     * would have made the diagnostic capable of causing the outage it exists to describe.
     *
     * The `boot` pass runs AFTER the gate opens, on purpose, the boot steps are what establish several of these
     * relationships (the vault sweep, the registry load), so a pass before them would report the state they were
     * about to fix. The sweep interval is the standing patrol for everything nothing in particular disturbs;
     * `turn-settled` catches the two records of a turn disagreeing at the moment one of them changes. */
    void services.invariants.run("boot");
    const invariantSweep = setInterval(() => void services.invariants.run("sweep"), 300_000);
    shutdown.push(() => clearInterval(invariantSweep));
    shutdown.push(onTurnSettled(() => void services.invariants.run("turn-settled")));

    /* BRING THE PHRASE INDEX LEVEL, detached and AFTER the gate, which is the whole point of it existing.
     *
     * Settling turns write this index forward, so in steady state this pass finds nothing to do and says
     * nothing. It is here for the first run (or a schema bump), for turns recorded while this daemon was not
     * running, and for the runtime sessions, which are the SDK's files and so can only be checked by looking.
     *
     * Detached because a search does not need it to have finished: the routes answer from what is indexed and
     * report `indexing` so a screen can say the list can still grow. Holding the gate on it would trade a fast
     * incomplete search for a slow boot, which is the trade this change exists to stop making.
     *
     * The interval catches session files the SDK appends to without telling us, on the same cadence as the
     * other standing patrols. `unref` so it never keeps the process up on its own. */
    const backfillSaid = (): void => {
        void services.saidIndex.backfill().catch((error: unknown) => logger.warn({ err: error }, "search index backfill failed"));
    };
    backfillSaid();
    const saidSweep = setInterval(backfillSaid, 600_000);
    saidSweep.unref();
    shutdown.push(() => clearInterval(saidSweep));

    /* The worktree sweeps, DETACHED: archive entries whose checkout vanished, prune orphaned dirs and stale
     * admin entries, park the branches of off-board agents. This is the spawn-heaviest part of a boot (git per
     * repo per conversation) and it used to hold serve(), after a crash, on a machine still thrashing, that
     * was most of the outage. It reads the registry through callbacks and takes the per-repo locks, so turns
     * that start while it walks are safe from it. */
    void (async () => {
        const vanished: string[] = [];
        const archived: string[] = [];
        for (const id of services.agents.ids()) {
            const entry = services.agents.entry(id);
            // Workspace conversations deliberately own no checkout. They participate in the roster, not in
            // worktree repair or pruning, so absence on disk is not a vanished isolated agent.
            if (entry?.branch === undefined) {
                continue;
            }
            // An ARCHIVED entry is *supposed* to have no worktree, that is what archiving reclaimed. It is
            // held by its commits instead, so it must never look like the vanished-worktree case below.
            if (entry.archivedAt !== undefined) {
                archived.push(id);
                continue;
            }
            if (!(await services.agentWorktrees.exists(id))) {
                vanished.push(id);
            }
        }
        // A live entry with no checkout is an ARCHIVED agent in every way that matters, off the board,
        // held by its branch, so that is what it becomes. This sweep used to `remove()` these outright,
        // and it was the fleet's quietest data loss: a rebuild that lost worktree dirs, or an unarchive
        // whose re-attach failed mid-way, left live entries with no checkout, and the next boot deleted
        // the user's only handle on their branches and transcripts. Deletion stays where the user can see
        // it: discard, and the archive's own purge. One write for the whole sweep either way.
        if (vanished.length > 0) {
            await services.agents.setArchived(vanished, Date.now());
            logger.info({ count: vanished.length }, "agents: archived entries whose worktree vanished");
        }
        // Membership is re-read per decision inside prune (the callbacks), so a conversation the user opens
        // mid-sweep is never judged by this pre-sweep snapshot.
        await services.agentWorktrees.prune(
            () => services.agents.ids().filter((id) => services.agents.entry(id)?.branch !== undefined),
            () =>
                services.agents
                    .ids()
                    .filter((id) => services.agents.entry(id)?.branch !== undefined && services.agents.entry(id)?.archivedAt !== undefined),
        );
    })().catch((error: unknown) => logger.warn({ err: error }, "agents: boot worktree sweep failed"));

    // Keep the Finished lane from becoming the sandbox's permanent record: archive agents that have sat
    // finished past the retention window (settings.agentRetentionDays; 0 ⇒ never). Once at boot, then hourly,
    // the window is measured in days, so nothing finer is worth a timer. Losslessly: see agents/archive.ts.
    const sweepArchive = (): Promise<void> =>
        services.sandboxSettings
            .get()
            .then((settings) => sweepAgedAgents(services, Date.now(), settings.agentRetentionDays * 24 * 60 * 60 * 1000))
            .then(() => undefined)
            .catch((error: unknown) => logger.warn({ err: error }, "agents: archive sweep failed"));
    if (role.roots) {
        void sweepArchive();
        setInterval(() => void sweepArchive(), 60 * 60 * 1000).unref();
        // The state dir's own garbage, scratch, retired derived roots, aged captures (state-janitor.ts).
        // Same cadence and guard as the agent sweeps: only the daemon that owns the roots collects them.
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

    // Git housekeeping (git/maintenance.ts): pack the refs and loose objects a fleet of conversations mints,
    // and keep the commit-graph current. Never awaited, it is the one boot step whose whole point is to run
    // while nothing is waiting on it, and a repo mid-relocation simply gets maintained an hour later.
    const maintain = (): Promise<void> => runGitMaintenance(services.workspace, logger);
    if (role.roots) {
        void maintain();
        setInterval(() => void maintain(), 60 * 60 * 1000).unref();
    }

    // Recompose the environment overlay from the manifest, converges fragment drift (a daemon update that
    // changes a capability's fragment flips the derived state to "pending rebuild"); no-op on fresh sandboxes.
    // Writes only under .intentic/ (in ROOT_EXCLUDES), so it never affects the baseline above.
    if (role.container) {
        void composeEnvironment(services);
    }

    // Preview routes for every existing repo (best-effort; the ensurer never throws), self-heals any repo
    // whose creation-time mint was missed, so hostnames exist well before a browser ever resolves them.
    if (role.container) {
        void ensureAllPreviewRoutes(services);
    }

    // Auto-connect VPN tunnels die with the container while the manifest survives on /work, dial them again
    // AFTER the sweep; dockerd starts the same way when a docker capability is enabled (the engine is baked
    // into every image but dormant without it). Both best-effort: a failure lands in the VPN link's state /
    // the daemon log, not the boot path.
    const bootCtx = capabilityCtx(services);
    if (role.container) {
        void reconnectVpns(services.capabilities, services.logger);
        /* Geo exits, restored the same way and with one extra job the VPNs do not have. An auto-start exit is
         * down and wants starting, the familiar half. But a tunnel-based exit's CLIENT survives the daemon
         * while the SOCKS proxy that published it does not, because that listener lived in this process: so
         * there can be a live tunnel with nothing serving it, and restoreExits re-publishes the proxy without
         * disturbing the tunnel. Best-effort like the VPNs, a dead relay must not take the boot path with it. */
        void restoreExits(services.capabilities, services.logger);
    }
    // Connector hooks' side effects die with the container the same way: the git keypair is on /history
    // (linked above), but the credential helper, the https line, the ssh-config Include and npm's ~/.npmrc
    // auth line were in HOME, re-derive them from the manifest so the owner's first `git pull` and the
    // agent's first clone or publish authenticate. HOME-level like the links they ride on, so it is the
    // owning daemon's to write (see the claim above).
    if (ownsHome) {
        void restoreConnectorHooks(services.capabilities, services.logger);
    }
    if (role.container) {
        void startDockerdIfEnabled(bootCtx);
    }
    // Local model servers die with the container the same way dockerd does, while the manifest and the
    // downloaded weights survive on /work: bring every ready one back. Best-effort like its siblings.
    if (role.container) {
        void startLocalModelsIfEnabled(bootCtx);
    }
    /* The translator (CLIProxyAPI) backing "Codex/Grok under the Claude Code harness": serves those providers on
     * their connected subscription OAuth, plus the user's own openai-protocol endpoints.
     *
     * GATED ON THE BINARY BEING IN THIS IMAGE, because it is a feature pack now (packs/translator.Dockerfile)
     * and a core image doesn't carry it. TRANSLATOR_URL is runner-set either way, so the URL alone stopped
     * meaning "there is a translator here". Ungated, the spawn fails ENOENT and the restart ladder retries it
     * for the daemon's lifetime, filling the log with a failure that is really just an image without the pack.
     * Starts whenever the binary is present so the Management API is listening for connect handshakes (Google,
     * Grok, Kimi) before an account has been stored. */
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
    // Extension BACKENDS (manifest `server` bundles) come up in their own supervised host process, proxied
    // under /x/<id>/, see extensions/backend/. Best-effort like the processes: a failure is the host's row
    // on the Extensions tab, never a boot failure.
    if (role.container) {
        services.extensionBackend.start().catch((error: unknown) => logger.warn({ err: error }, "extension backend host failed to start"));
    }

    // Debug-log upkeep: re-arm the tmux pipe-pane hooks on a tmux server that outlived a daemon restart
    // (best-effort; the image's tmux.conf covers server start) and sweep historyRoot/logs at boot + hourly.
    if (role.container) {
        void applyTmuxLogHooks(config.historyRoot);
    }
    // Root-scoped: these are the logs of whoever owns this history root, and a guest sharing it prunes nothing.
    if (role.roots) {
        void pruneLogFiles(logsRoot(config.historyRoot));
    }
    const logsSweep = role.roots ? setInterval(() => void pruneLogFiles(logsRoot(config.historyRoot)), 3_600_000) : undefined;
    shutdown.push(() => clearInterval(logsSweep));

    // Session retention (terminal-session.ts): abandoned web-* shells, which are exempt from the boot sweep
    // because they're the user's own, plus the job-* sessions of flows that finished hours ago and that the
    // panel has long stopped tabbing. Both at boot + hourly. The `keep` predicate is what makes it safe to run
    // unattended: a job whose runner still has something queued has only dead panes but is not finished, the
    // same fact system.routes reports as `running`. agent-* sessions belong to the reaper below.
    const stillWorking = (session: string): boolean => services.terminalRun.running(session);
    if (role.container) {
        void reapFinishedSessions(stillWorking);
    }
    const sessionSweep = role.container ? setInterval(() => void reapFinishedSessions(stillWorking), 3_600_000) : undefined;
    shutdown.push(() => clearInterval(sessionSweep));

    /* THE REAPER (platform/reaper.ts): everything a stopped conversation still holds, the provider CLI tree
     * with its MCP servers and browsers, its agent-* tmux sessions live panes included, its browser records,
     * and the temp state turns mint, reclaimed on the conversation's own stop clock, seeded by the settle
     * event. Container-role only, exactly like the sweeps it replaced: a guest daemon owns none of this. */
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

    // The condition watches (agent/watchers.ts): agent-armed checks the daemon polls between turns, waking the
    // arming conversation when one fires. Wired here because the wake is a turn and the turn generator cannot
    // be imported from under turn-plan, where the arming tool lives. Stop drops every armed watch, a daemon on
    // its way down cannot check anything, and the record honestly gone beats a timer into a dead process.
    shutdown.push(startWatchers(services, streamAgent));

    /* The post publisher, armed rather than polled: it reads the drafts queue, works out the soonest approved
     * post's due time, and sleeps until exactly that. Arming here is what carries a hold across a restart, a
     * post approved a minute before the daemon went down is due the moment it is back, and this is the read
     * that notices. Nothing approved means no timer at all. */
    const draftsPublisher = draftsPublisherFor(services);
    // Nothing is lost by dropping the armed timer: the deadline it was holding is the draft's own
    // scheduledAt on disk, and the next boot arms from that.
    shutdown.push(() => draftsPublisher.stop());
    // A pre-push check is a suite running on the main tree, a daemon that exits without killing it
    // leaves it burning CPU with nothing left to report the result to.
    shutdown.push(() => prepushCheck(services).cancel());
    if (role.container) {
        void draftsPublisher.arm().catch((error: unknown) => logger.warn({ err: error }, "drafts publisher not armed"));
    }

    // CI webhooks: keep every mapped workspace repo's github/gitlab hook pointing at this sandbox (boot pass +
    // interval), so completed pipelines wake `ci` automations and freshen the Pipelines view.
    if (role.container) {
        services.ciHooks.start();
    }

    // And the fallback under it: poll the repos whose hook could NOT be registered (no public URL, a token
    // without hook scope) so their `ci` automations still fire. Its first pass is a silent seed, so starting it
    // before the reconciler's first warnings have landed costs nothing. See ci/poller.ts.
    const ciPoller = createCiPoller(services, streamAgent);
    shutdown.push(() => ciPoller.stop());
    if (role.container) {
        ciPoller.start();
    }

    // Maintenance probes: refresh expired measurements (pnpm outdated/audit, knip, jscpd) so the rail can tell
    // the owner something they did not already know. Serialized across the sandbox, skipped entirely while any
    // turn is live, and behind a warm-up, a probe racing the boot's `pnpm install` measures a tree that does not
    // exist yet. See chores/probe-runner.ts for why none of it is allowed to be urgent.
    if (role.container) {
        services.probeRunner.start();
    }

    // Resume scheduler: credential refusals and provider outages re-run the turn they killed, see
    // turn-resume.ts. A spent usage limit is deliberately not among them; that allowance is the user's own.
    const turnResume = createTurnResumeScheduler(services, streamAgent);
    shutdown.push(() => turnResume.stop());
    if (role.roots) {
        turnResume.start();
    }

    // Restart auto-resume, the third condition in turn-resume.ts: the turn journal on /history holds every turn
    // and automation fire that was in flight, so whatever survived to here is what the daemon died under, a
    // rebuild, an environment approval, a dev-sandbox.sh swap, an OOM kill. Re-run once each, gated by
    // autoResumeOnRestart (off by default) and bounded by an attempt count so a turn that kills the daemon cannot
    // loop the boot. Detached: an interrupted turn is a whole agent turn and must not hold the daemon's start.
    void resumeInterruptedTurns(services, streamAgent).catch((error: unknown) =>
        logger.error({ err: error }, "interrupted turns could not be resumed, they stand on the record as interrupted"),
    );

    // The same restart story for loops and workflow runs, coordinated because every workflow step IS a loop.
    // Two independent passes can both claim the same persisted loop and race its conversation/worktree; the
    // coordinator reserves workflow-owned conversations before generic loop recovery sees the remainder.
    void resumeWorkflowExecution(services, streamAgent).catch((error: unknown) =>
        logger.error({ err: error }, "loops and workflow runs could not be resumed"),
    );

    // Stamp this workspace with the newest version that ever ran it (forward-only), what lets a manifest
    // problem after a rollback read as "written by a newer intentic" instead of "your file is broken"
    // (store/newest-run.ts). Backgrounded: the stamp only sharpens a sentence, it gates nothing.
    if (role.roots) {
        void recordNewestRun(config.workspaceRoot).catch(() => undefined);
    }

    // Warm the "latest released sandbox version" cache in the background so /info can offer a non-blocking
    // update without ever fetching on the request path. Channel-aware: a stable sandbox is offered the
    // promoted release, a beta one the newest (version-check.ts explains the two pointers).
    // Container-image update offers: meaningless for a local daemon, whose host application owns updates.
    const versionCheck = traits.containerUpdates ? startVersionCheck() : undefined;
    shutdown.push(() => versionCheck?.stop());

    // …and what that update would actually give them, on the same cadence: the offer and the reason to take it
    // come from two different reads (the Release's "latest" pointer for the version, the Release bodies for
    // the notes) and neither may hold up the /info that shows them.
    const releaseNotesCheck = traits.containerUpdates ? startReleaseNotesCheck() : undefined;
    shutdown.push(() => releaseNotesCheck?.stop());

    // The same courtesy for installed EXTENSIONS: compare each pinned sha against its registry (updates,
    // advisories) shortly after boot and daily after, the Extensions tab's own reads keep it fresher.
    const extensionUpdateWatch = traits.extensionHost ? startExtensionUpdateWatch(services) : undefined;
    shutdown.push(() => extensionUpdateWatch?.stop());

    // The same bargain for "can each agent runtime serve a turn": probed off the turn path so the picker can
    // say a subscription is missing BEFORE a prompt is written, rather than as that turn's failure.
    startRuntimeHealth(services);

    // Realtime agent wake-ups are provider gateways now: a listener extension (ext-discord) runs an autoStart
    // process that holds the connection and drives the daemon's /listeners/<provider> routes, the daemon holds
    // no gateway of its own. The process exists only while its provider is wanted (a connector or an enabled
    // listener automation): startAllExtensionProcesses gates the boot start, reconcileListenerProcesses
    // converges on every automations/capabilities mutation.

    // Workspace history: an immediate snapshot plus the interval sweep (turn snapshots ride on streamAgent).
    services.history.start();

    // Live file-change push: watch /work so the browser's tree + open file refresh the instant the agent (or a
    // Bash command / the terminal) touches a file, over the /events stream, no manual Refresh.
    startWorkspaceWatch(services.workspace.root, logger);
    // The resident search engine revalidates on the same watch stream, so a query never pays re-indexing for
    // the agent's latest writes inline, it serves the current index and the refresh happens between queries.
    subscribeWorkspaceChanges(() => services.iq.markDirty());
    /* Extension backends converge on the same stream: an edit to a workspace extension (an agent authoring one
     * with its own file tools, the whole point of that load path), a fresh git-installed checkout, or a flip
     * of the enablement file restarts the backend host so the new code is what serves. Loaded code cannot be
     * unloaded, so the restart IS the reload, debounced in the supervisor, and a no-op while no extension
     * ships a backend. */
    subscribeWorkspaceChanges((paths) => {
        if (paths.some(extensionSource)) {
            services.extensionBackend.restart();
        }
    });
    // Repo-set change push riding the same watcher: a repo cloned/deleted anywhere under /work re-frames the
    // discovered repo list on /events (the watcher itself never sees .git paths).
    startRepoWatch(services.workspace.root, logger);
    // Ref-move push, riding the repo set the line above maintains: a commit, checkout, branch, tag or rebase in
    // ANY workspace repo re-frames the surfaces built on the commit graph. Neither watcher above can carry it,
    // git dirs live off /work entirely (repo-git-dirs.ts) and the file watcher ignores .git besides.
    startRefWatch(services.workspace.root, subscribeRepoChanges, logger);
    // The agent plane converges on the same feed, in the one direction a conversation's FROZEN composition
    // cannot absorb by itself: a repo that has been deleted is taken out of every composition that still names
    // it, and its stranded checkouts are reclaimed (agents/vanished-repos.ts explains what leaving them costs).
    shutdown.push(startVanishedRepoSweep(services, subscribeRepoChanges));

    // Warm the resident search engine (sweep + symbols + the embedding backlog) so the first search hits a ready
    // index. Incremental, a valid on-disk index survives boot instead of being dropped and rebuilt, and it runs
    // on the engine's own worker thread: this used to be minutes of parse/chunk/SQLite work on THIS loop, which
    // put every browser request behind it (seconds each, for 0.4 kB reads) for as long as a boot re-index took.
    // Awaiting it is just an observation point; nothing here blocks on it.
    void services.iq.warm().catch((error: unknown) => logger.warn({ err: error }, "iq index warmup failed, search runs on the index as it stands"));

    /* Nothing to enumerate: every subsystem registered itself where it was created. The store keeps going past
     * a member that throws and reports the failures together, so one misbehaving stop cannot strand the ports
     * and child processes behind it in the list.
     *
     * `finally`, because the exit must happen whatever the teardown did. The old list had the same exposure and
     * worse odds, a throwing stop skipped every stop after it AND the exit, leaving a daemon that answered
     * SIGTERM by hanging with its marker unstamped, which the next boot reads as a crash. */
    const stop = (): void => {
        logger.info("shutting down intentic sandbox daemon…");
        try {
            shutdown.dispose();
        } catch (error) {
            logger.error({ err: error }, "shutdown: one or more subsystems failed to stop");
        } finally {
            // process.exit fires the "exit" hook above, which stamps the marker "exited", the next boot's death
            // check reads a deliberate shutdown, not a crash.
            process.exit(0);
        }
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
};

void main();
