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
import { startTranslator } from "./agent/translator.js";
import { DOCKER_PANEL_KEY, startEnabledDocker } from "./capabilities/handlers/docker.js";
import { reconnectVpns } from "./capabilities/handlers/vpn.js";
import { writeCodexConfig } from "./codex/codex-credentials.js";
import { createServices } from "./composition.js";
import { ensureDraftsSkill } from "./drafts/drafts-store.js";
import { startAllExtensionProcesses } from "./extensions/extension-processes.js";
import { commitRootBaseline, ensureRootRepo } from "./git/root-repo.js";
import { reconcileSkills } from "./settings/skills.js";
import { composeEnvironment } from "./environment/environment.js";
import { loadConfig } from "./env.config.js";
import { createLogger } from "./logger.js";
import { applyTmuxLogHooks, logsRoot, pruneLogFiles, terminalLogsDir } from "./logs/log-files.js";
import { applyEventsPath, applyRunLive } from "./intentic/apply-events.js";
import { checkEventsDir } from "./intentic/check-run.js";
import { INFRA_APPLY_KEY } from "./intentic/infra-apply.js";
import { killStaleManagedSessions, panelSession } from "./processes/managed-processes.js";
import { createPreviewProxy } from "./panels/preview-proxy.js";
import { ensureAllPreviewRoutes } from "./panels/preview-route.js";
import { linkClaudeProjects } from "./sessions/session-store.js";
import { createAnnouncer } from "./platform/announce.js";
import { seedPairing } from "./platform/sync.js";
import { reapIdleWebSessions } from "./terminal/terminal-session.js";
import { startVersionCheck } from "./platform/version-check.js";
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

    // Privacy defaults for the OPENAI_API_KEY-fallback CODEX_HOME (per-account homes get theirs at connect time,
    // codex-credentials.ts writeTokens). Best-effort: a Codex turn works without it, just unhardened.
    void writeCodexConfig(join(services.authRoot, "codex")).catch((error: unknown) =>
        logger.warn({ err: error }, "codex privacy config not written"),
    );

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
    // excludes. Awaited (cheap, and the git routes assume it), but a failure must not take the daemon down — a
    // failure reads as "not fresh" so we skip the baseline commit below.
    const freshRoot = await ensureRootRepo(services.workspace, config.historyRoot).catch((error: unknown) => {
        logger.warn({ err: error }, "root workspace repo not ensured — the Changes review will degrade");
        return false;
    });

    // The fleet registry: load persisted conversations, drop entries whose worktree vanished, sweep orphaned
    // worktree dirs + stale admin entries (`git worktree prune`). Awaited (cheap, and the /agents routes assume
    // a loaded registry); a failure degrades to an empty fleet, never a dead daemon.
    await services.agents
        .init()
        .then(async () => {
            for (const id of services.agents.ids()) {
                if (!(await services.agentWorktrees.exists(id))) {
                    await services.agents.remove(id);
                }
            }
            await services.agentWorktrees.prune(services.agents.ids());
        })
        .catch((error: unknown) => logger.warn({ err: error }, "agents registry not initialized — the fleet starts empty"));

    // Recompose the environment overlay from the manifest — converges fragment drift (a daemon update that
    // changes a capability's fragment flips the derived state to "pending rebuild"); no-op on fresh sandboxes.
    // Writes only under .intentic/ (in ROOT_EXCLUDES), so it never affects the baseline below.
    void composeEnvironment(services);

    // Converge the daemon-owned /work skill files BEFORE the baseline commit so a fresh sandbox reads clean
    // instead of surfacing them as a phantom add. Awaited for exactly that ordering; still log-and-continue, and
    // on a non-fresh boot (no baseline) their writes become ordinary pending changes for the Changes review.
    // - the drafts skill: how the agent writes post drafts for approval, so its prose tracks the daemon.
    await ensureDraftsSkill(services).catch((error: unknown) => logger.warn({ err: error }, "drafts skill not converged"));
    // - the baked-tool skills, per the settings `skills` list — each present only when named (the CLIs are
    //   always on PATH; the skill file is what surfaces one to the agent).
    await services.sandboxSettings
        .get()
        .then((settings) => reconcileSkills(services, settings.skills))
        .catch((error: unknown) => logger.warn({ err: error }, "skill reconcile failed"));

    // Baseline "Initialize workspace" commit, taken once on a fresh sandbox now that the daemon's /work-owned
    // files exist — so the Changes review starts with zero pending changes.
    if (freshRoot) {
        await commitRootBaseline(services.workspace).catch((error: unknown) =>
            logger.warn({ err: error }, "root baseline commit failed — the Changes review will start dirty"),
        );
    }

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
        (await services.processes.adopt(INFRA_APPLY_KEY, { oneShot: true }).catch(() => false));
    const dockerAlive = await services.processes.adopt(DOCKER_PANEL_KEY, {}).catch(() => false);
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
    // The translator (CLIProxyAPI) backing "Codex/Grok under the Claude Code harness": starts when TRANSLATOR_URL
    // is baked (no-op on a bare dev run) and serves those providers on their connected subscription OAuth.
    // Best-effort — a routed turn that finds it down surfaces its own error, and a native-harness turn never touches it.
    startTranslator(services);
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
    const previewProxy = createPreviewProxy(services.processes.portOf, sandboxIdFromToken(config.connectToken));
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
    // process that holds the connection and drives the daemon's /listeners/<provider> routes — the daemon holds
    // no gateway of its own. The process exists only while its provider is wanted (a connector or an enabled
    // listener automation): startAllExtensionProcesses gates the boot start, reconcileListenerProcesses
    // converges on every automations/capabilities mutation.

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
    void services.openCode
        .client()
        .catch((error: unknown) => logger.warn({ err: error }, "opencode warmup failed — first grok connect boots it lazily"));

    const shutdown = (): void => {
        logger.info("shutting down intentic sandbox daemon…");
        clearInterval(logsSweep);
        clearInterval(webSessionSweep);
        scheduler.stop();
        versionCheck.stop();
        announcer.stop();
        services.history.stop();
        // Stops the extension gateway processes too (tmux kill-session ⇒ SIGHUP) — each flushes its own
        // in-flight voice transcript on the way down.
        services.processes.stopAll();
        previewProxy.close();
        server.close();
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
};

void main();
