import { mkdir, rm } from "node:fs/promises";
import { createSecureServer } from "node:http2";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { publicSlotFromToken, sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { observeGitCommands } from "@intentic/scaffold";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import { WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { sweepAgedAgents } from "./agents/archive.js";
import { streamAgent } from "./agent/agent.routes.js";
import { createTurnResumeScheduler, resumeInterruptedTurns } from "./agent/turn-resume.js";
import { resumeWorkflowExecution } from "./workflows/workflow-runner.js";
import { seedDefaultAutomations } from "./automations/default-automations.js";
import { seedDefaultPersonas } from "./personas/default-personas.js";
import { createAutomationsScheduler } from "./automations/scheduler.js";
import { emitWorkspaceEvent } from "./automations/workspace-events.js";
import { statePath } from "./workspace/state-paths.js";
import { capabilityCtx } from "./capabilities/capability.js";
import { restoreConnectorHooks } from "./capabilities/cli/connector-hooks.js";
import { linkSshHosts } from "./capabilities/ssh-hosts.js";
import { startTranslator, translatorWanted } from "./agent/translator.js";
import { onPath } from "./platform/on-path.js";
import { DOCKER_PANEL_KEY, startDockerdIfEnabled } from "./capabilities/handlers/docker.js";
import { writeAgentToken } from "./auth/agent-token.js";
import { startClaudeRefresh } from "./claude/claude-credentials.js";
import { createCiPoller } from "./ci/poller.js";
import { reconnectVpns } from "./vpn/vpn-links.js";
import { writeCodexConfig } from "./codex/codex-config.js";
import { AGENT_SIGNALS_DIR, watchDelegationSignals } from "./agent/delegation-signals.js";
import { createServices } from "./composition.js";
import { draftsPublisherFor } from "./drafts/drafts-publisher.js";
import { ensureDraftsSkill } from "./drafts/drafts-store.js";
import { startAllExtensionProcesses } from "./extensions/extension-processes.js";
import { runGitMaintenance } from "./git/maintenance.js";
import { prepushCheck } from "./prepush/prepush.js";
import { ensureRepoGitDirs } from "./git/repo-git-dirs.js";
import { commitRootBaseline, ensureRootRepo } from "./git/root-repo.js";
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
import { claimContainerHome } from "./platform/home-owner.js";
import { startLoopWatchdog } from "./platform/loop-watchdog.js";
import { startResourceMetrics } from "./platform/resource-metrics.js";
import { DAEMON_OWNER, startLeftoverSweep } from "./platform/leftovers.js";
import { startWorkloadPriorityGovernor } from "./platform/workload-priority.js";
import { turnRunMetrics, turnRunOf } from "./agent/turn-runs.js";
import { browserSessionMetrics } from "./browser/browser-sessions.js";
import { readLocalCertificate, startLocalCertificateRenewal } from "./platform/local-cert.js";
import { restoreAuthorizedKeys, seedPairing } from "./platform/sync.js";
import { seedSetupHost } from "./hosts/host-seed.js";
import { panePids, reapFinishedSessions } from "./terminal/terminal-session.js";
import { startVersionCheck } from "./platform/version-check.js";
import { startRuntimeHealth } from "./agent/adapter-health.js";
import { startRepoWatch, subscribeRepoChanges } from "./workspace/repo-watch.js";
import { startRefWatch } from "./git/ref-watch.js";
import { startWorkspaceWatch, subscribeWorkspaceChanges } from "./workspace/workspace-watch.js";

// The sandbox container's entrypoint. Config comes from env set at `docker run` — by connect.sh (your PC) or
// the workspace provider (a server); the workspace (the repos) and agent credentials are injected there,
// never baked in.
//
// LISTEN FIRST, CONVERGE BEHIND THE GATE. The boot chain below (state links, git-dir healing, the registry
// load) used to run before serve(), so every daemon death cost its crash PLUS a couple of minutes of
// connection-refused while sweeps re-walked a fleet of worktrees — the browser sat on the reconnect screen
// for all of it. The listeners now come up immediately: /health and /events answer at once (the UI paints,
// heartbeats flow), and every data route waits on the readiness gate (app.ts), which resolves when the chain
// finishes — the same ordering guarantees, minus the outage.
//
// The chain NAMES ITSELF, in the table below. Every awaited step is declared here before any of it runs, so
// /health and /events can report which one is in flight and how far along the boot is — the browser holds its
// reads and shows the wait rather than painting an operable workspace over a daemon that answers nothing (see
// platform/boot.ts). A step added below without an entry here does not compile: the `boot` alias in main() is
// narrowed to these keys, so an undeclared one is a type error rather than a throw that strands the gate shut.
const BOOT_STEPS = [
    { key: "authorizedKeys", label: "Restoring desktop enrollments" },
    { key: "claudeState", label: "Linking conversation state" },
    { key: "sshHosts", label: "Linking ssh hosts" },
    { key: "rootRepo", label: "Preparing the workspace repo" },
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
 * `google.clientId` is what builds the authorizer (composition.ts). Empty is a legitimate mode — the tests and
 * the host-internal server preview run loopback with no auth at all — but it is legitimate only for a daemon
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
 * credential, which no amount of inference can distinguish from the misconfiguration above — so the harness
 * says it in the container env and the daemon repeats it in `docker logs` on every boot. env.config.ts carries
 * the full note, including the caller list it must stay at. */
const requireAuthWhenReachable = (config: Config): void => {
    if (config.google.clientId !== "" || (config.connectToken === "" && config.sandbox.publicUrl === "")) {
        return;
    }
    if (config.sandbox.allowUnauthenticated) {
        process.stderr.write(
            "WARNING: SANDBOX_ALLOW_UNAUTHENTICATED is set — this daemon is reachable (CONNECT_TOKEN / SANDBOX_PUBLIC_URL)\n" +
                "and authenticates NOBODY: terminals, secrets and the file API answer any caller that reaches this port.\n" +
                "Only the e2e harnesses set this. If you are not one of them, unset it and set GOOGLE_CLIENT_ID instead.\n",
        );
        return;
    }
    // Before the logger: this must be legible in `docker logs` even when log config is part of what went wrong.
    process.stderr.write(
        "FATAL: this sandbox is externally reachable (CONNECT_TOKEN / SANDBOX_PUBLIC_URL is set) but GOOGLE_CLIENT_ID is empty.\n" +
            "Without it the daemon authenticates nobody and every route — terminals, secrets, the file API — is open to anyone\n" +
            "who can reach the tunnel. Set GOOGLE_CLIENT_ID to the platform's Google web client id and restart.\n",
    );
    process.exit(78); // EX_CONFIG
};

// A workspace-relative path that is extension SOURCE — the three places a backend extension's code or its
// enablement can arrive from. Module scope so the watcher's callback doesn't rebuild it on every change batch.
const extensionSource = (path: string): boolean =>
    path.startsWith(`${STATE_DIR}/workspace-extensions/`) ||
    path.startsWith(`${STATE_DIR}/extensions/`) ||
    path === `${STATE_DIR}/extension-enablement.json`;

const main = async (): Promise<void> => {
    const config = loadConfig();
    requireAuthWhenReachable(config);
    // Every intentic CLI run spawned in here (the /intentic routes, the panel-infra-apply tmux session) tees
    // its output to the daemon-owned logs tree — the same INTENTIC_LOG_DIR contract as an operator shell.
    process.env["INTENTIC_LOG_DIR"] ??= join(logsRoot(config.historyRoot), "intentic-runs");
    // The agent env spreads process.env (agent.ts baseOptions), so bin/tmux-run and the output filter
    // inherit where the pipe-pane hooks persist raw pane logs — the filter footer's escape hatch.
    process.env["INTENTIC_TERMINAL_LOGS_DIR"] ??= terminalLogsDir(config.historyRoot);
    const logger = createLogger(config);
    // ponytail: log-and-continue, don't exit. The daemon's whole job is to stay up for /agent + /events; a
    // rejected best-effort boot job (the void reconnectVpns/composeEnvironment/ensureAllPreviewRoutes/… below)
    // must not take the origin down. A genuinely fatal state is rare, and --restart unless-stopped still
    // catches a hard crash. The pre-logger config-load throw stays unguarded — a bad config should crash loudly.
    process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled rejection"));
    process.on("uncaughtException", (err) => logger.error({ err }, "uncaught exception"));
    // Death forensics: name the previous run's unannounced death (with its fatal report, when V8 wrote one)
    // and stamp this run's marker; the exit hook below is what flips it to "exited" on every deliberate path.
    // Skipped without a history volume (dev, tests) — same opt-out as the file log destination.
    if (config.historyRoot !== "") {
        const bootMarker = claimBootMarker(logsRoot(config.historyRoot), logger);
        process.on("exit", (code) => bootMarker.markExited(code));
    }
    // The stall detector: any future freeze — a synchronous path in here, or the whole VM thrashing under a
    // fleet of builds — leaves a log line with the lag and the machine's pressure numbers attributing it.
    const loopWatchdog = startLoopWatchdog(logger);
    // Provider SDKs spawn their CLIs internally, outside the polite Bash/git wrappers. Keep every direct child
    // below the control plane so a newly introduced workload cannot compete equally with /events heartbeats.
    const workloadPriority = startWorkloadPriorityGovernor();
    const services = createServices(config, logger);
    const resourceMetrics = startResourceMetrics({
        historyRoot: config.historyRoot,
        logger,
        owners: () => ({ ...services.resourceOwners(), turnRuns: turnRunMetrics(), browserSessions: browserSessionMetrics() }),
    });
    /* Point the scaffold's git seam at the perf tracker, so every git this daemon runs — the Changes scan's
     * hundreds of reads, a land's checkout, the history snapshots — is attributable. Git is where the reported
     * slowness lives and it was the one subsystem with no measurement at all.
     *
     * `dir` is trimmed to a workspace-relative name: absolute paths make every line wrap and the prefix is the
     * same on all of them. `args` keeps the subcommand and its flags but drops trailing operands, which are
     * pathspecs — a `checkout -- <400 paths>` would otherwise put 400 paths in a log line, and the subcommand
     * is what identifies the op anyway. */
    observeGitCommands(({ dir, args, ms, attempts, failed, forked }) => {
        services.perf.record(
            "git.run",
            ms,
            {
                git: args.slice(0, 3).join(" "),
                repo: dir.startsWith(services.workspace.root) ? dir.slice(services.workspace.root.length + 1) || "root" : dir,
                ...(attempts > 1 ? { lockRetries: attempts - 1 } : {}),
                // Only worth a field when it is FALSE: a direct exec pays the parent's page-table copy on every
                // call (~27ms at this daemon's resident size), which is a whole class of slowness on its own.
                ...(forked ? {} : { forked: false }),
            },
            failed,
        );
    });

    /* The sandbox-wide CODEX_HOME's config.toml: privacy hardening plus, when a translator is baked, the
     * `translator` model_provider on the ChatGPT subscription — the default that serves the Claude agent's shell
     * delegation (its freeform `codex exec` can't pass per-turn overrides). Best-effort; authoritative overwrite.
     *
     * "Baked" is the BINARY, not TRANSLATOR_URL. The runner sets that URL on every image, so on a core one it
     * would select a model_provider nothing is listening on and every delegated `codex exec` would fail against
     * a dead port. Empty instead ⇒ Codex's own OPENAI_API_KEY provider, which is the one credential such a
     * sandbox may still have. */
    void (async () => {
        const translatorUrl = (await onPath("cli-proxy-api")) ? config.translator.url : "";
        await writeCodexConfig(join(services.authRoot, "codex"), translatorUrl, AGENT_SIGNALS_DIR);
    })().catch((error: unknown) => logger.warn({ err: error }, "codex config not written"));

    // The other end of those hooks: fold what delegated CLIs report (their session id, blocked, their last
    // words) into the subagent roster. Best-effort like the config write above — a sandbox without the spool
    // still settles every delegation through the Bash result path.
    void watchDelegationSignals(AGENT_SIGNALS_DIR, (error: unknown) => logger.warn({ err: error }, "delegation signal dropped")).catch(
        (error: unknown) => logger.warn({ err: error }, "delegation signals not watched"),
    );

    // Setup-time desktop sync: arm the platform-minted pairing token so the connect script can enroll its agent.
    // No-op once that token has been redeemed — the burn is recorded on /history, so the copy living in the
    // container's env cannot be replayed by a restart (see seedPairing). Detached: the connect script's agent
    // retries its enroll, so nothing here needs to hold the boot.
    if (config.syncPairToken !== "") {
        void seedPairing(config.historyRoot, config.syncPairToken).catch((error: unknown) =>
            logger.warn({ err: error }, "setup pairing not armed — enable desktop sync from the browser instead"),
        );
    }

    /* Setup-time CONNECTED COMPUTER: create the card for the machine that ran the installer and arm its pairing,
     * so the agent that same flow installed can enroll. A no-op on every boot after the first — the token is
     * burned on /history when it is redeemed — and on every sandbox that was set up before this existed.
     *
     * Detached like the sync seed above: the machine agent retries its enroll on its own backoff, so nothing here
     * needs to hold the boot. A failure leaves the computer unconnected and the Computers view saying so, which
     * is exactly what it said before this existed. */
    if (config.hostPairToken !== "") {
        void seedSetupHost(services, { token: config.hostPairToken, platform: config.hostPlatform, label: config.hostLabel })
            .then(({ armed, id }) => {
                if (armed) {
                    logger.info(
                        { host: id },
                        "setup computer armed — it may manage this machine's sandboxes; widen or revoke on its capability card",
                    );
                }
            })
            .catch((error: unknown) =>
                logger.warn({ err: error }, "setup computer not connected — add it from Capabilities to manage this machine's sandboxes"),
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
    // wants a plain boolean under exactOptionalPropertyTypes. The shapes match at runtime — assert the interface.
    const terminalSockets = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    const server = serve({ fetch: app.fetch, port: config.sandbox.port, hostname: config.sandbox.host, websocket: { server: terminalSockets } });
    logger.info({ host: config.sandbox.host, port: config.sandbox.port, workspace: config.workspaceRoot }, "intentic sandbox daemon listening");

    /* THE LOOPBACK LISTENER — the same app on a second port, and the only one ever published to the host, so a
     * browser on this machine reaches the daemon directly instead of crossing to a Cloudflare edge and back.
     *
     * A second listener rather than TLS on the one above, because the two ports answer to different callers:
     * the tunnel connector dials this daemon in plain HTTP over the container network and would break the
     * moment 8787 spoke TLS, while the browser needs TLS or Safari refuses the address as mixed content.
     *
     * The certificate is whatever is already on disk — issuance is a CA validating DNS, far slower than a boot
     * should wait, so it happens in the background and lands at the next restart. Without one the listener
     * serves plain HTTP, which Chrome and Firefox still accept for loopback; the browser probes both and the
     * daemon's identity decides. Its own WebSocket server: `ws` in noServer mode is bound to one HTTP server,
     * so sharing the instance above would leave terminals on this port unupgradeable.
     *
     * HTTP/2, and that is not a performance nicety — it is what stops the workspace freezing. A browser allows
     * SIX concurrent HTTP/1.1 connections per origin, and this app holds LONG-LIVED ones: `/events` forever,
     * plus an `/agent/attach` for every conversation with a live turn (plus `/intentic/apply/events`, plus any
     * popped-out window, all sharing the one origin). Four or five running agents therefore consume every slot,
     * and the next request — any ordinary read — has nowhere to go and simply queues in the browser until a
     * stream ends. Nothing is wrong daemon-side, which is exactly why it presents as "the sandbox froze" with a
     * silent, healthy log; only dropping the sockets (a reload of every tab, or clearing site data) frees it.
     * One h2 connection carries ~100 concurrent streams instead, so the cap stops binding at any realistic
     * number of agents.
     *
     * `allowHTTP1` is required rather than tidy: WebSocket has no h2 form here (Node does not advertise the
     * extended-CONNECT setting RFC 8441 needs), so the browser opens a SEPARATE http/1.1 connection for the
     * terminal — which this accepts, and whose `upgrade` event still reaches the `ws` server above. It is also
     * the fallback for any client that does not do ALPN at all. */
    const localCertificate = readLocalCertificate(config);
    const localSockets = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    const localServer = serve({
        fetch: app.fetch,
        port: config.local.port,
        hostname: config.sandbox.host,
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
                      // connection — which is now ALL of them, including transcript replays that arrive in
                      // multi-megabyte bursts. Exceeding it kills the session, i.e. the whole workspace's
                      // connection at once, so the ceiling has to be sized for the multiplexing this enables.
                      maxSessionMemory: 128,
                  },
              }),
    });
    logger.info({ port: config.local.port, tls: localCertificate !== undefined, hostname: localCertificate?.hostname }, "loopback listener ready");
    // Obtain/renew in the background. Never rejects: a sandbox with no certificate is a working sandbox.
    const localCertRenewal = startLocalCertificateRenewal(config, logger);

    // The preview proxy: preview-<panel>-<id>.<zone>, port-<slot>-<id>.<zone> and public-<slot>-<id>.<zone>
    // land here (the tunnel's fixed origin) and the Host header's first label routes to the panel's running
    // port, the slot's forwarded port, or the workspace's outbox. Always listening — with nothing up it answers
    // 502, not connection-refused. Everything it serves is public — no owner-gating.
    //
    // The outbox needs the connect token for its salted slot, so a token-less daemon (tests, loopback) simply
    // has no address to publish at. The handler is bound to public/ whether or not that directory exists: the
    // dir's existence is the switch, and it is checked per request, so `mkdir public` starts publishing without
    // a restart and `rm -rf public` stops it just as immediately.
    const previewProxy = createPreviewProxy({
        portOf: services.processes.portOf,
        slotTargetOf: services.portForwards.targetOf,
        sandboxId: sandboxIdFromToken(config.connectToken),
        outbox:
            config.connectToken === ""
                ? undefined
                : { slot: publicSlotFromToken(config.connectToken), serve: createPublicHandler(publicRoot(config.workspaceRoot)) },
    });
    previewProxy.listen(config.preview.port, config.sandbox.host);

    // Phone home: announce this sandbox's URL to the platform registry (once per boot, retried until acked —
    // see platform/announce.ts), so the setup wizard sees it come online without any browser→sandbox probing.
    // Needs all three env values — headless/test runs without them just don't announce. Started with the
    // listeners, not after the boot chain: the announcement is how a waiting browser learns the daemon is
    // back, and it must not queue behind the very sweeps it would be reporting through.
    if (config.platform.url !== "" && config.sandbox.publicUrl !== "" && config.connectToken !== "") {
        services.announcer.start();
    }

    /* Ask the platform whether this sandbox gets a free trial, and how much of today's allowance is left. The
     * answer IS the trial endpoint's existence (trial/trial-endpoint.ts), so this runs beside the announce
     * rather than inside the boot chain: a user whose first act is to open the chat must find the trial already
     * there, not appear a sweep later. Unawaited and self-swallowing — a platform that never answers leaves the
     * sandbox with no trial, which is the failure that costs the user nothing. */
    void services.trial.refresh();

    // Every awaited step below runs through the tracker: it stamps the step's state and elapsed time, logs the
    // slow ones (a boot that takes minutes has ONE slow step, and until it is named every slow boot reads as
    // "the daemon is just slow"), and streams the transition to whatever browser is watching. Narrowed to the
    // declared keys so the table above is enforced at compile time — a step whose entry someone forgot used to
    // throw on its first run, which aborts the chain, leaves the gate shut forever and reads to the user as a
    // browser stuck on the boot screen behind a daemon whose log says only "unhandled rejection".
    const boot: BootTracker<(typeof BOOT_STEPS)[number]["key"]> = services.boot;

    // ~/.ssh and ~/.claude are the CONTAINER's filesystem, shared by every process in it — so the jobs below that
    // converge them onto THIS run's roots (the three steps here, plus the git-access restore further down) run
    // only for the daemon that owns HOME. A second daemon started in here — a dev run rooted under /tmp — would
    // otherwise repoint the live daemon's git keys and conversation state at its own empty roots, and nothing
    // would notice until a push was refused: see platform/home-owner.ts for the day that happened.
    const ownsHome = claimContainerHome({ workspaceRoot: config.workspaceRoot, historyRoot: config.historyRoot }, logger);

    // Desktop enrollments live on /history and outlive the container; the authorized_keys sshd reads does NOT
    // (it is ~/.ssh, container-local), so re-derive it from the store before sshd serves a laptop's first
    // reconnect. Ordered before the gate resolves — a rebuild otherwise leaves every enrollment valid but unauthorized.
    await boot.step("authorizedKeys", async () => {
        if (!ownsHome) {
            return;
        }
        await restoreAuthorizedKeys(config.historyRoot).catch((error: unknown) =>
            logger.warn({ err: error }, "authorized_keys not restored — enrolled machines will be refused until they re-enroll"),
        );
    });

    // Claude conversation state (transcripts, plans, backups, task outputs, todos) lives under the SDK's
    // ~/.claude — ephemeral container fs. Converge every store onto /work BEFORE the gate opens (turns wait on
    // it, so the CLI can never race this). Awaited, unlike the best-effort steps below, because a turn
    // spawning the CLI mid-link would fork stores.
    await boot.step("claudeState", async () => {
        if (!ownsHome) {
            return;
        }
        await linkClaudeState(services.workspace.root).catch((error: unknown) =>
            logger.warn({ err: error }, "claude session state not persisted — sessions will not survive a rebuild whole"),
        );
    });

    // The managed ssh dir (git-provider keys + every ssh capability's key) is the other store that lived in the
    // container's ephemeral HOME — point it at the /history volume before anything reads or writes an alias, so
    // a recreate stops silently taking git access and the ssh machines down with it. Awaited for that ordering;
    // a failure (a dev-host run, where the guard refuses to touch a real ~/.ssh/intentic-hosts) leaves the
    // pre-existing local dir in place rather than the daemon down.
    await boot.step("sshHosts", async () => {
        if (!ownsHome) {
            return;
        }
        await linkSshHosts(config.historyRoot).catch((error: unknown) =>
            logger.warn({ err: error }, "ssh hosts dir not persisted — git access and ssh aliases will not survive a rebuild"),
        );
    });

    // The /work workspace repo (the Changes review's "root"): init once, heal the .git pointer, converge
    // excludes. Awaited (cheap, and the git routes assume it), but a failure must not take the daemon down — a
    // failure reads as "not fresh" so we skip the baseline commit below.
    const freshRoot = await boot.step("rootRepo", () =>
        ensureRootRepo(services.workspace, config.historyRoot).catch((error: unknown) => {
            logger.warn({ err: error }, "root workspace repo not ensured — the Changes review will degrade");
            return false;
        }),
    );

    // The reference shelf (REFERENCE_DIR, @intentic/workspace-ignore): furniture, like .intentic — its presence
    // IS the affordance. Every scanner already excludes it; without the dir on disk the convention is invisible
    // (nothing to drop onto, nothing in the tree to explain itself). Idempotent, so a shelf deleted mid-session
    // stays gone until the next boot re-ensures an empty one.
    await boot.step("referenceShelf", () =>
        mkdir(join(config.workspaceRoot, REFERENCE_DIR), { recursive: true }).catch((error: unknown) =>
            logger.warn({ err: error }, "reference shelf not ensured — refs/ drops have no target"),
        ),
    );

    // An environment export half-written when the daemon stopped. Only a LIVE process can be writing a `.part`,
    // so one that survived a restart is an export that will never finish — marked failed here so the card shows
    // a reason instead of a progress bar that never moves again (portability/exports.ts).
    await boot.step("staleExports", () =>
        sweepStaleExports(config.historyRoot).catch((error: unknown) =>
            logger.warn({ err: error }, "stale exports not swept — an interrupted export may still read as packing"),
        ),
    );

    // No repo keeps its git dir under /work: a worktree's gitdir pointer has to resolve identically inside an
    // isolated turn's namespace, where /work IS that worktree (agents/isolation.ts). Every daemon-created repo
    // is already shaped this way; this converges the ones that arrived by other roads. After ensureRootRepo,
    // whose excludes it does not disturb, and before the registry loads the worktrees it repairs.
    await boot.step("repoGitDirs", () => ensureRepoGitDirs(services.workspace, config.historyRoot, logger));

    // The fleet registry: load persisted conversations and broadcast the roster (an /events stream opened
    // during boot is already holding an empty fleet). Awaited — the /agents routes assume a loaded registry —
    // but a failure degrades to an empty fleet, never a dead daemon. The worktree sweeps run DETACHED below.
    await boot.step("agentsRegistry", () =>
        services.agents.init().catch((error: unknown) => logger.warn({ err: error }, "agents registry not initialized — the fleet starts empty")),
    );

    // Converge the daemon-owned /work skill files BEFORE the baseline commit so a fresh sandbox reads clean
    // instead of surfacing them as a phantom add. Awaited for exactly that ordering; still log-and-continue, and
    // on a non-fresh boot (no baseline) their writes become ordinary pending changes for the Changes review.
    // - the drafts skill: how the agent writes post drafts for approval, so its prose tracks the daemon.
    // - the baked-tool skills, per the settings `skills` list — each present only when named (the CLIs are
    //   always on PATH; the skill file is what surfaces one to the agent).
    await boot.step("skills", async () => {
        await ensureDraftsSkill(services).catch((error: unknown) => logger.warn({ err: error }, "drafts skill not converged"));
        await services.sandboxSettings
            .get()
            .then((settings) => reconcileSkills(services, settings.skills))
            .catch((error: unknown) => logger.warn({ err: error }, "skill reconcile failed"));
    });

    // Baseline "Initialize workspace" commit, taken once on a fresh sandbox now that the daemon's /work-owned
    // files exist — so the Changes review starts with zero pending changes.
    await boot.step("baseline", async () => {
        if (freshRoot) {
            await commitRootBaseline(services.workspace).catch((error: unknown) =>
                logger.warn({ err: error }, "root baseline commit failed — the Changes review will start dirty"),
            );
        }
    });

    // Panel/agent/job tmux sessions outlive a daemon restart (the tmux server is container-scoped) — kill
    // leftovers so "panels are stopped after a restart" holds and no orphan dev server squats an untracked
    // port. EXCEPT a live infra apply (killing it would truncate the host mutation mid-run, orphan the host
    // apply lock for its TTL, and report the run complete — when the event log records a started-but-not-exited
    // run and its session survives, re-adopt it; the web reattaches through the same event log) and a live
    // dockerd (panel-docker keeps serving containers across daemon restarts — adopt it back). The sweep is
    // ORDERED before the gate opens so the capability restores below can't race a kill of the session they
    // just started.
    await boot.step("staleSessions", async () => {
        const applyLive =
            (await applyRunLive(applyEventsPath(config.historyRoot)).catch(() => false)) &&
            (await services.processes.adopt(INFRA_APPLY_KEY, { oneShot: true }).catch(() => false));
        const dockerAlive = await services.processes.adopt(DOCKER_PANEL_KEY, {}).catch(() => false);
        await killStaleManagedSessions([
            ...(applyLive ? [panelSession(INFRA_APPLY_KEY)] : []),
            ...(dockerAlive ? [panelSession(DOCKER_PANEL_KEY)] : []),
        ]).catch(() => undefined);
    });
    // A previous boot's check runs left per-run event files behind (their streams died with the daemon).
    void rm(checkEventsDir(config.historyRoot), { recursive: true, force: true });

    // The in-container `vpn` CLI reads this to reach the daemon's /vpn routes; written before the restores
    // below so a tunnel the agent dials during boot already has a token to present.
    await boot.step("agentToken", () =>
        writeAgentToken(services.agentToken).catch((error: unknown) => services.logger.warn({ err: error }, "agent token: could not write")),
    );

    /* Reserve dependency maintenance before the data gate opens. The workspace watcher itself starts below,
     * but its subscriber set is intentionally usable before then; registering now also starts the boot scan.
     * A turn arriving the instant boot finishes therefore queues behind an already-reserved repair instead of
     * becoming the race that discovers the stale tree. */
    const dependencyChecks: VerifyDeps = {
        workspace: services.workspace,
        processes: services.processes,
        maintenance: services.workspaceMaintenance,
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
                content: `Installing dependencies for ${named} — ${reason}.`,
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

    // The state the data routes serve is converged — open the gate. Everything below is background machinery
    // that no queued request depends on.
    boot.finish();

    /* The worktree sweeps, DETACHED: archive entries whose checkout vanished, prune orphaned dirs and stale
     * admin entries, park the branches of off-board agents. This is the spawn-heaviest part of a boot (git per
     * repo per conversation) and it used to hold serve() — after a crash, on a machine still thrashing, that
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
            // An ARCHIVED entry is *supposed* to have no worktree — that is what archiving reclaimed. It is
            // held by its commits instead, so it must never look like the vanished-worktree case below.
            if (entry.archivedAt !== undefined) {
                archived.push(id);
                continue;
            }
            if (!(await services.agentWorktrees.exists(id))) {
                vanished.push(id);
            }
        }
        // A live entry with no checkout is an ARCHIVED agent in every way that matters — off the board,
        // held by its branch — so that is what it becomes. This sweep used to `remove()` these outright,
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
    // finished past the retention window (settings.agentRetentionDays; 0 ⇒ never). Once at boot, then hourly —
    // the window is measured in days, so nothing finer is worth a timer. Losslessly: see agents/archive.ts.
    const sweepArchive = (): Promise<void> =>
        services.sandboxSettings
            .get()
            .then((settings) => sweepAgedAgents(services, Date.now(), settings.agentRetentionDays * 24 * 60 * 60 * 1000))
            .then(() => undefined)
            .catch((error: unknown) => logger.warn({ err: error }, "agents: archive sweep failed"));
    void sweepArchive();
    setInterval(() => void sweepArchive(), 60 * 60 * 1000).unref();

    // Git housekeeping (git/maintenance.ts): pack the refs and loose objects a fleet of conversations mints,
    // and keep the commit-graph current. Never awaited — it is the one boot step whose whole point is to run
    // while nothing is waiting on it, and a repo mid-relocation simply gets maintained an hour later.
    const maintain = (): Promise<void> => runGitMaintenance(services.workspace, logger);
    void maintain();
    setInterval(() => void maintain(), 60 * 60 * 1000).unref();

    // Recompose the environment overlay from the manifest — converges fragment drift (a daemon update that
    // changes a capability's fragment flips the derived state to "pending rebuild"); no-op on fresh sandboxes.
    // Writes only under .intentic/ (in ROOT_EXCLUDES), so it never affects the baseline above.
    void composeEnvironment(services);

    // Preview routes for every existing repo (best-effort; the ensurer never throws) — self-heals any repo
    // whose creation-time mint was missed, so hostnames exist well before a browser ever resolves them.
    void ensureAllPreviewRoutes(services);

    // Auto-connect VPN tunnels die with the container while the manifest survives on /work — dial them again
    // AFTER the sweep; dockerd starts the same way when a docker capability is enabled (the engine is baked
    // into every image but dormant without it). Both best-effort: a failure lands in the VPN link's state /
    // the daemon log, not the boot path.
    const bootCtx = capabilityCtx(services);
    void reconnectVpns(services.capabilities, services.logger);
    // Connector hooks' side effects die with the container the same way: the git keypair is on /history
    // (linked above), but the credential helper, the https line, the ssh-config Include and npm's ~/.npmrc
    // auth line were in HOME — re-derive them from the manifest so the owner's first `git pull` and the
    // agent's first clone or publish authenticate. HOME-level like the links they ride on, so it is the
    // owning daemon's to write (see the claim above).
    if (ownsHome) {
        void restoreConnectorHooks(services.capabilities, services.logger);
    }
    void startDockerdIfEnabled(bootCtx);
    /* The translator (CLIProxyAPI) backing "Codex/Grok under the Claude Code harness": serves those providers on
     * their connected subscription OAuth, plus the user's own openai-protocol endpoints.
     *
     * GATED ON THE BINARY BEING IN THIS IMAGE, because it is a feature pack now (packs/translator.Dockerfile)
     * and a core image doesn't carry it — TRANSLATOR_URL is runner-set either way, so the URL alone stopped
     * meaning "there is a translator here". Ungated, the spawn fails ENOENT and the restart ladder retries it
     * for the daemon's lifetime, filling the log with a failure that is really just an image without the pack.
     * And gated on there being something to serve: the auth-dir/endpoint read (never the Management API, which
     * is the very proxy this decides to start) keeps a sandbox nobody has connected anything to from running a
     * proxy for nothing. A turn that later wants it says so itself, naming the rebuild. */
    void (async () => {
        if (config.translator.url === "") {
            return;
        }
        if (!(await onPath("cli-proxy-api"))) {
            logger.info("translator: cli-proxy-api is not in this image — add it by rebuilding from the Environment card");
            return;
        }
        if (await translatorWanted(services)) {
            startTranslator(services);
        }
    })().catch((error: unknown) => logger.warn({ err: error }, "translator: start gate failed"));
    // Installed extensions' declared autoStart processes come back the same way (manifests on /work).
    void startAllExtensionProcesses(services);
    // Extension BACKENDS (manifest `server` bundles) come up in their own supervised host process, proxied
    // under /x/<id>/ — see extensions/backend/. Best-effort like the processes: a failure is the host's row
    // on the Extensions tab, never a boot failure.
    services.extensionBackend.start().catch((error: unknown) => logger.warn({ err: error }, "extension backend host failed to start"));

    // Debug-log upkeep: re-arm the tmux pipe-pane hooks on a tmux server that outlived a daemon restart
    // (best-effort; the image's tmux.conf covers server start) and sweep historyRoot/logs at boot + hourly.
    void applyTmuxLogHooks(config.historyRoot);
    void pruneLogFiles(logsRoot(config.historyRoot));
    const logsSweep = setInterval(() => void pruneLogFiles(logsRoot(config.historyRoot)), 3_600_000);

    // Session retention (terminal-session.ts): abandoned web-* shells, which are exempt from the boot sweep
    // because they're the user's own, plus the agent-*/job-* sessions of work that finished hours ago and that
    // the panel has long stopped tabbing. Both at boot + hourly. The `keep` predicate is what makes it safe to
    // run unattended: an agent BETWEEN two commands has only dead panes, and so does a job whose runner still
    // has something queued — the same two facts system.routes reports as `running`.
    const stillWorking = (session: string): boolean =>
        services.terminalRun.running(session) || services.agents.liveSessionIds().some((sessionId) => agentSessionName(sessionId) === session);
    void reapFinishedSessions(stillWorking);
    const sessionSweep = setInterval(() => void reapFinishedSessions(stillWorking), 3_600_000);

    /* Process retention (platform/leftovers.ts): the provider CLIs, MCP servers and headless browsers a turn
     * started, reclaimed once the turn that owns them has finished. Sessions above are the tmux half of the same
     * job and this is the half nothing was doing — a turn's tree below the CLI has no handle anyone here holds,
     * so a stopped turn, a killed CLI or a replaced daemon simply left it running.
     *
     * Owner liveness is the turn registry and nothing else, so there is no second definition of alive to keep
     * true. The two reserved owners answer for themselves: what the daemon keeps warm on purpose (the ACP/Pi
     * pools, the translator) is live for as long as this daemon is, and a helper one-shot never is. */
    const leftovers = startLeftoverSweep({
        ownerLive: (owner) => owner === DAEMON_OWNER || turnRunOf(owner)?.done === false,
        panePids,
        logger,
    });
    void leftovers.sweep();

    /* The stock personas a workspace starts with, offered exactly once — a deleted seed stays deleted.
     *
     * BEFORE THE AUTOMATIONS, because one of them names a persona: the Doorbell recipe runs as `visitor`, and a
     * seeded automation pointing at a card that does not exist yet is a wake that can do nothing at all until
     * the next boot. Two seeds, one order, and the dependency runs this way round. */
    await seedDefaultPersonas(services.personas, statePath(services.workspace.root, ".intentic/personas.seeded.json")).catch((error: unknown) =>
        services.logger.warn({ err: error }, "default personas: seed failed"),
    );

    // The stock automations a workspace starts with (currently the dependency fix chore), offered exactly
    // once — a deleted seed stays deleted. Before the scheduler so the first tick already sees them.
    await seedDefaultAutomations(services.automations, statePath(services.workspace.root, ".intentic/automations.seeded.json")).catch(
        (error: unknown) => services.logger.warn({ err: error }, "default automations: seed failed"),
    );

    // Scheduled agent wake-ups: poll the automations manifest and fire whatever comes due.
    const scheduler = createAutomationsScheduler(services, streamAgent);
    scheduler.start();

    /* The post publisher, armed rather than polled: it reads the drafts queue, works out the soonest approved
     * post's due time, and sleeps until exactly that. Arming here is what carries a hold across a restart — a
     * post approved a minute before the daemon went down is due the moment it is back, and this is the read
     * that notices. Nothing approved means no timer at all. */
    const draftsPublisher = draftsPublisherFor(services);
    void draftsPublisher.arm().catch((error: unknown) => logger.warn({ err: error }, "drafts publisher not armed"));

    // CI webhooks: keep every mapped workspace repo's github/gitlab hook pointing at this sandbox (boot pass +
    // interval), so completed pipelines wake `ci` automations and freshen the Pipelines view.
    services.ciHooks.start();

    // And the fallback under it: poll the repos whose hook could NOT be registered (no public URL, a token
    // without hook scope) so their `ci` automations still fire. Its first pass is a silent seed, so starting it
    // before the reconciler's first warnings have landed costs nothing. See ci/poller.ts.
    const ciPoller = createCiPoller(services, streamAgent);
    ciPoller.start();

    // Maintenance probes: refresh expired measurements (pnpm outdated/audit, knip, jscpd) so the rail can tell
    // the owner something they did not already know. Serialized across the sandbox, skipped entirely while any
    // turn is live, and behind a warm-up — a probe racing the boot's `pnpm install` measures a tree that does not
    // exist yet. See chores/probe-runner.ts for why none of it is allowed to be urgent.
    services.probeRunner.start();

    // Resume scheduler: credential refusals and provider outages re-run the turn they killed — see
    // turn-resume.ts. A spent usage limit is deliberately not among them; that allowance is the user's own.
    const turnResume = createTurnResumeScheduler(services, streamAgent);
    turnResume.start();

    // Restart auto-resume, the third condition in turn-resume.ts: the turn journal on /history holds every turn
    // and automation fire that was in flight, so whatever survived to here is what the daemon died under — a
    // rebuild, an environment approval, a dev-sandbox.sh swap, an OOM kill. Re-run once each, gated by
    // autoResumeOnRestart (off by default) and bounded by an attempt count so a turn that kills the daemon cannot
    // loop the boot. Detached: an interrupted turn is a whole agent turn and must not hold the daemon's start.
    void resumeInterruptedTurns(services, streamAgent).catch((error: unknown) =>
        logger.error({ err: error }, "interrupted turns could not be resumed — they stand on the record as interrupted"),
    );

    // The same restart story for loops and workflow runs, coordinated because every workflow step IS a loop.
    // Two independent passes can both claim the same persisted loop and race its conversation/worktree; the
    // coordinator reserves workflow-owned conversations before generic loop recovery sees the remainder.
    void resumeWorkflowExecution(services, streamAgent).catch((error: unknown) =>
        logger.error({ err: error }, "loops and workflow runs could not be resumed"),
    );

    // Warm the "latest released sandbox version" cache in the background so /info can offer a non-blocking
    // update without ever fetching on the request path.
    const versionCheck = startVersionCheck();

    // The same bargain for "can each agent runtime serve a turn": probed off the turn path so the picker can
    // say a subscription is missing BEFORE a prompt is written, rather than as that turn's failure.
    startRuntimeHealth(services);

    // Realtime agent wake-ups are provider gateways now: a listener extension (ext-discord) runs an autoStart
    // process that holds the connection and drives the daemon's /listeners/<provider> routes — the daemon holds
    // no gateway of its own. The process exists only while its provider is wanted (a connector or an enabled
    // listener automation): startAllExtensionProcesses gates the boot start, reconcileListenerProcesses
    // converges on every automations/capabilities mutation.

    // Workspace history: an immediate snapshot plus the interval sweep (turn snapshots ride on streamAgent).
    services.history.start();

    // Live file-change push: watch /work so the browser's tree + open file refresh the instant the agent (or a
    // Bash command / the terminal) touches a file, over the /events stream — no manual Refresh.
    startWorkspaceWatch(services.workspace.root, logger);
    // The resident search engine revalidates on the same watch stream, so a query never pays re-indexing for
    // the agent's latest writes inline — it serves the current index and the refresh happens between queries.
    subscribeWorkspaceChanges(() => services.iq.markDirty());
    /* Extension backends converge on the same stream: an edit to a workspace extension (an agent authoring one
     * with its own file tools — the whole point of that load path), a fresh git-installed checkout, or a flip
     * of the enablement file restarts the backend host so the new code is what serves. Loaded code cannot be
     * unloaded, so the restart IS the reload — debounced in the supervisor, and a no-op while no extension
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
    // ANY workspace repo re-frames the surfaces built on the commit graph. Neither watcher above can carry it —
    // git dirs live off /work entirely (repo-git-dirs.ts) and the file watcher ignores .git besides.
    startRefWatch(services.workspace.root, subscribeRepoChanges, logger);

    // Rotate Claude subscription tokens on a quiet timer rather than letting a burst of turn starts discover the
    // expiry together. Anthropic rotates refresh tokens and revokes the whole family on a replay, so the goal is
    // for a turn to never be the thing that triggers a refresh — the locking in claude-credentials is the
    // backstop for when it is anyway.
    startClaudeRefresh(services.claudeStore);

    // Read every Claude account's plan limits now, and every few minutes after. The account list waits on its
    // own sweep, so this is for the readings nobody is looking at: which account an unattributed turn runs on is
    // decided by what is on file (accountWithHeadroom), and before this the file only ever knew about accounts
    // that had recently run a turn — so an account another Claude Code had spent all week still looked like the
    // one with the most room.
    services.claudeUsage.start();

    // Warm the resident search engine (sweep + symbols + the embedding backlog) so the first search hits a ready
    // index. Incremental — a valid on-disk index survives boot instead of being dropped and rebuilt — and it runs
    // on the engine's own worker thread: this used to be minutes of parse/chunk/SQLite work on THIS loop, which
    // put every browser request behind it (seconds each, for 0.4 kB reads) for as long as a boot re-index took.
    // Awaiting it is just an observation point; nothing here blocks on it.
    void services.iq.warm().catch((error: unknown) => logger.warn({ err: error }, "iq index warmup failed — search runs on the index as it stands"));

    /* Warm the Grok provider's OpenCode server at boot instead of lazily on the first /grok/oauth/start. The cold
     * `opencode serve` spawn is CPU-heavy; in a constrained container it can deschedule the daemon long enough to
     * stall the /events heartbeat past the browser's watchdog, flashing the UI to "connecting" mid-session — which
     * unmounts the account page and aborts the in-flight Grok connect. At boot that spike hides behind the initial
     * connect screen. Best-effort: ensure() is idempotent, so the first interactive call reuses this warm client.
     *
     * Warming is for a provider somebody USES, so it waits on the xAI credential OpenCode itself persists — a
     * sandbox that has never connected Grok was paying a ~175 MB bun spawn on every boot to hold a server for a
     * provider with no account behind it. And on a core image the binary is a pack away (packs/opencode.Dockerfile),
     * where the spawn only ever ends in the SDK's start timeout; the lazy path a connect takes says so properly. */
    void (async () => {
        if (!(await services.openCode.connected("xai"))) {
            return;
        }
        if (!(await onPath("opencode"))) {
            logger.info("opencode: the binary is not in this image — add it by rebuilding from the Environment card");
            return;
        }
        await services.openCode.client();
    })().catch((error: unknown) => logger.warn({ err: error }, "opencode warmup failed — first grok connect boots it lazily"));

    const shutdown = (): void => {
        logger.info("shutting down intentic sandbox daemon…");
        resourceMetrics.stop();
        loopWatchdog.stop();
        services.perf.stop();
        clearInterval(logsSweep);
        clearInterval(sessionSweep);
        leftovers.stop();
        scheduler.stop();
        // Nothing is lost by dropping the armed timer: the deadline it was holding is the draft's own
        // scheduledAt on disk, and the next boot arms from that.
        draftsPublisher.stop();
        // A pre-push check is a suite running on the main tree — a daemon that exits without killing it leaves
        // it burning CPU with nothing left to report the result to.
        prepushCheck(services).cancel();
        workloadPriority.stop();
        services.ciHooks.stop();
        ciPoller.stop();
        turnResume.stop();
        versionCheck.stop();
        services.announcer.stop();
        localCertRenewal.stop();
        services.history.stop();
        // Stops the extension gateway processes too (tmux kill-session ⇒ SIGHUP) — each flushes its own
        // in-flight voice transcript on the way down.
        services.processes.stopAll();
        // The backend host is a direct child, not a tmux session — stopped here or it outlives the daemon.
        services.extensionBackend.stop();
        previewProxy.close();
        localServer.close();
        server.close();
        // process.exit fires the "exit" hook above, which stamps the marker "exited" — the next boot's death
        // check reads a deliberate shutdown, not a crash.
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
};

void main();
