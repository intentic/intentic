import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { createAutomationsScheduler } from "./automations/scheduler.js";
import { capabilityCtx } from "./capabilities/capability.js";
import { DOCKER_PANEL_KEY, startEnabledDocker } from "./capabilities/handlers/docker.js";
import { reconnectVpns } from "./capabilities/handlers/vpn.js";
import { createServices } from "./composition.js";
import { ensureDraftsSkill } from "./drafts/drafts-store.js";
import { startAllExtensionProcesses } from "./extensions/extension-processes.js";
import { ensureRootRepo } from "./git/root-repo.js";
import { reconcileLspSkill } from "./settings/lsp-skill.js";
import { composeEnvironment } from "./environment/environment.js";
import { loadConfig } from "./env.config.js";
import { createLogger } from "./logger.js";
import { applyTmuxLogHooks, logsRoot, pruneLogFiles, terminalLogsDir } from "./logs/log-files.js";
import { applyEventsPath, applyRunLive } from "./intentic/apply-events.js";
import { checkEventsDir } from "./intentic/check-run.js";
import { INFRA_APPLY_KEY } from "./intentic/infra-apply.js";
import { killStaleManagedSessions, panelSession } from "./panels/panel-processes.js";
import { createPreviewProxy } from "./panels/preview-proxy.js";
import { ensureAllPreviewRoutes } from "./panels/preview-route.js";
import { linkClaudeProjects } from "./sessions/session-store.js";
import { createAnnouncer } from "./system/announce.js";
import { seedPairing } from "./system/sync.js";
import { reapIdleWebSessions } from "./system/terminal-session.js";
import { startVersionCheck } from "./system/version-check.js";
import { startWorkspaceWatch } from "./workspace/workspace-watch.js";

// The sandbox container's entrypoint. Config comes from env set at `docker run` — by connect.sh (your PC) or
// the workspace provider (a server); the workspace (the repos) and agent credentials are injected there,
// never baked in.
const main = async (): Promise<void> => {
    const config = loadConfig();
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
    const services = createServices(config, logger);

    // Setup-time desktop sync: arm the platform-minted pairing token so the connect script can enroll its agent.
    if (config.syncPairToken !== "") {
        seedPairing(config.syncPairToken);
    }

    // Claude chat transcripts live in the SDK's ~/.claude/projects — ephemeral container fs. Converge the
    // store onto /work BEFORE serving (turns can't arrive until serve(), so the CLI can never race this).
    // Awaited, unlike the best-effort steps below, because a turn spawning the CLI mid-link would fork stores.
    await linkClaudeProjects(services.workspace.root).catch((error: unknown) =>
        logger.warn({ err: error }, "claude session store not persisted — transcripts will not survive a rebuild"),
    );

    // The /work workspace repo (the Changes review's "root"): init once, heal the .git pointer, converge
    // excludes. Awaited (cheap, and the git routes assume it), but a failure must not take the daemon down.
    await ensureRootRepo(services.workspace, config.historyRoot).catch((error: unknown) =>
        logger.warn({ err: error }, "root workspace repo not ensured — the Changes review will degrade"),
    );

    // Recompose the environment overlay from the manifest — converges fragment drift (a daemon update that
    // changes a capability's fragment flips the derived state to "pending rebuild"); no-op on fresh sandboxes.
    void composeEnvironment(services);

    // Converge the drafts skill (how the agent writes post drafts for approval) so its prose tracks the daemon.
    void ensureDraftsSkill(services);

    // Converge the lsp skill with the lspTools toggle — present only when the owner enabled it (the `lsp` CLI is
    // always on PATH; the skill is what surfaces it to the agent).
    void services.sandboxSettings
        .get()
        .then((settings) => reconcileLspSkill(services, settings.lspTools))
        .catch((error: unknown) => logger.warn({ err: error }, "lsp skill reconcile failed"));

    // Preview routes for every existing repo (best-effort; the ensurer never throws) — self-heals any repo
    // whose creation-time mint was missed, so hostnames exist well before a browser ever resolves them.
    void ensureAllPreviewRoutes(services);

    // Panel/agent/job tmux sessions outlive a daemon restart (the tmux server is container-scoped) — kill
    // leftovers so "panels are stopped after a restart" holds and no orphan dev server squats an untracked
    // port. EXCEPT a live infra apply (killing it would truncate the host mutation mid-run, orphan the host
    // apply lock for its TTL, and report the run complete — when the event log records a started-but-not-exited
    // run and its session survives, re-adopt it; the web reattaches through the same event log) and a live
    // dockerd (panel-docker keeps serving containers across daemon restarts — adopt it back). The sweep is
    // AWAITED so the capability restores below can't race a kill of the session they just started.
    const applyLive =
        (await applyRunLive(applyEventsPath(config.historyRoot)).catch(() => false)) &&
        (await services.panelProcesses.adopt(INFRA_APPLY_KEY, { oneShot: true }).catch(() => false));
    const dockerAlive = await services.panelProcesses.adopt(DOCKER_PANEL_KEY, {}).catch(() => false);
    await killStaleManagedSessions([
        ...(applyLive ? [panelSession(INFRA_APPLY_KEY)] : []),
        ...(dockerAlive ? [panelSession(DOCKER_PANEL_KEY)] : []),
    ]).catch(() => undefined);
    // A previous boot's check runs left per-run event files behind (their streams died with the daemon).
    void rm(checkEventsDir(config.historyRoot), { recursive: true, force: true });

    // Enabled VPN tunnels + the Docker daemon die with the container while the manifest survives on /work —
    // bring them back up AFTER the sweep (both best-effort; a failure lands in the capability's status, not
    // the boot path).
    void reconnectVpns(capabilityCtx(services));
    void startEnabledDocker(capabilityCtx(services));
    // Installed extensions' declared autoStart processes come back the same way (manifests on /work).
    void startAllExtensionProcesses(services);

    // Debug-log upkeep: re-arm the tmux pipe-pane hooks on a tmux server that outlived a daemon restart
    // (best-effort; the image's tmux.conf covers server start) and sweep historyRoot/logs at boot + hourly.
    void applyTmuxLogHooks(config.historyRoot);
    void pruneLogFiles(logsRoot(config.historyRoot));
    const logsSweep = setInterval(() => void pruneLogFiles(logsRoot(config.historyRoot)), 3_600_000);

    // Abandoned interactive shells: web-* sessions are exempt from the boot sweep (they're the user's own), so
    // detached ones idle for days would pile up until the container restarts — reap them at boot + hourly.
    void reapIdleWebSessions();
    const webSessionSweep = setInterval(() => void reapIdleWebSessions(), 3_600_000);

    const app = createApp(services);
    // The interactive-terminal WebSocket (/system/terminal) rides node-server's native WS support: `ws` in
    // noServer mode handles the upgrade, node-server routes it through Hono's upgradeWebSocket to the terminal.
    // `ws`'s WebSocketServer types its options.noServer as `boolean | undefined`; node-server's WebSocketServerLike
    // wants a plain boolean under exactOptionalPropertyTypes. The shapes match at runtime — assert the interface.
    const terminalSockets = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    const server = serve({ fetch: app.fetch, port: config.sandbox.port, hostname: config.sandbox.host, websocket: { server: terminalSockets } });
    logger.info({ host: config.sandbox.host, port: config.sandbox.port, workspace: config.workspaceRoot }, "intentic sandbox daemon listening");

    // The preview proxy: preview-<panel>-<id>.<zone> lands here (the tunnel's fixed origin) and the Host
    // header's first label routes to the matching panel's running port. Always listening — with no panel up it
    // answers 502 ("start it"), not connection-refused. Every preview is public — no owner-gating.
    const previewProxy = createPreviewProxy(services.panelProcesses.portOf, sandboxIdFromToken(config.connectToken));
    previewProxy.listen(config.preview.port, config.sandbox.host);

    // Scheduled agent wake-ups: poll the automations manifest and fire whatever comes due.
    const scheduler = createAutomationsScheduler(services);
    scheduler.start();

    // Warm the "latest released sandbox version" cache in the background so /info can offer a non-blocking
    // update without ever fetching on the request path.
    const versionCheck = startVersionCheck();

    // Phone home: announce this sandbox's URL + liveness to the platform registry (boot + every 30s), so the
    // setup wizard sees it come online without any browser→sandbox probing. Needs all three env values —
    // headless/test runs without them just don't announce.
    const announcer = createAnnouncer(config, logger);
    if (config.platform.url !== "" && config.sandbox.publicUrl !== "" && config.connectToken !== "") {
        announcer.start();
    }

    // Realtime agent wake-ups are provider gateways now: a listener extension (ext-discord) runs an autoStart
    // process that holds the connection and drives the daemon's /listeners/<provider> routes (started via
    // startAllExtensionProcesses below) — the daemon holds no gateway of its own.

    // Workspace history: an immediate snapshot plus the interval sweep (turn snapshots ride on streamAgent).
    services.history.start();

    // Live file-change push: watch /work so the browser's tree + open file refresh the instant the agent (or a
    // Bash command / the terminal) touches a file, over the /events stream — no manual Refresh.
    startWorkspaceWatch(services.workspace.root, logger);

    // Warm the iq search index (symbols + embeddings) so the agent's first search hits a fresh index instead of
    // paying the full build. Best-effort: on failure iq self-builds incrementally on first use.
    void promisify(execFile)("iq", ["index", "rebuild"], {
        cwd: services.workspace.root,
        env: { ...process.env, WORKSPACE_ROOT: services.workspace.root },
    }).catch((error: unknown) => logger.warn({ err: error }, "iq index warmup failed — first query builds incrementally"));

    // Warm the Grok provider's OpenCode server at boot instead of lazily on the first /grok/oauth/start. The cold
    // `opencode serve` spawn is CPU-heavy; in a constrained container it can deschedule the daemon long enough to
    // stall the /events heartbeat past the browser's watchdog, flashing the UI to "connecting" mid-session — which
    // unmounts the account page and aborts the in-flight Grok connect. At boot that spike hides behind the initial
    // connect screen. Best-effort: ensure() is idempotent, so the first interactive call reuses this warm client.
    void services.openCode.client().catch((error: unknown) => logger.warn({ err: error }, "opencode warmup failed — first grok connect boots it lazily"));

    const shutdown = (): void => {
        logger.info("shutting down intentic sandbox daemon…");
        clearInterval(logsSweep);
        clearInterval(webSessionSweep);
        scheduler.stop();
        versionCheck.stop();
        announcer.stop();
        services.history.stop();
        // Stops the extension gateway processes too (tmux SIGTERM) — each flushes its own in-flight voice
        // transcript on the way down.
        services.panelProcesses.stopAll();
        previewProxy.close();
        server.close();
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
};

void main();
