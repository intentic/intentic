import { createServer } from "node:http";
import { closeTelegramConnection, FatalTelegramError, openTelegramConnection, telegramConnection, telegramConnections } from "./client.js";
import type { GatewayCtx } from "./context.js";
import { createDaemonClient, type TelegramConnectorConfig } from "./daemon.js";
import { createTelegramListener } from "./listener.js";
import { log } from "./log.js";

// The Telegram gateway process: a baked extension's autoStart process (contributes.processes). It reconciles one
// long-polling connection per configured bot against the daemon's /listeners/telegram/state, dispatches every
// inbound message (painting mention replies back into the chat), and reports its liveness. The daemon holds no
// Telegram connection — this does.

// A fatal connect (revoked token, a webhook already claiming this bot's updates) pauses that token's reconnect
// this long; a BotFather-side fix must heal unattended, so it's not sticky forever.
const FATAL_RETRY_MS = 300_000;
const RECONCILE_MS = 30_000;
const STATUS_MS = 30_000;

const requireEnv = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") {
        log.error({ name }, "missing required env — the gateway can't start");
        process.exit(1);
    }
    return value;
};

const main = async (): Promise<void> => {
    const daemonBase = requireEnv("INTENTIC_DAEMON");
    const panelToken = requireEnv("INTENTIC_PANEL_TOKEN");
    const port = Number(requireEnv("PORT"));

    const daemon = createDaemonClient(daemonBase, panelToken);
    const ctx: GatewayCtx = { daemon, log };
    const listener = createTelegramListener(ctx, telegramConnections);

    // The reconcile-owned view: which bot token each capability is currently connected on. The token IS the
    // config key here (it is the only field), so an edit shows up as a different token.
    const wired = new Map<string, string>();
    const connecting = new Set<string>();
    const fatalUntil = new Map<string, number>();
    let connectors: ReadonlyArray<{ id: string; config: TelegramConnectorConfig }> = [];
    let listening = false;

    const reconcile = async (): Promise<void> => {
        const state = await daemon.state().catch((error: unknown) => {
            log.error({ err: error }, "listener state fetch failed");
            return undefined;
        });
        if (state === undefined) {
            return;
        }
        connectors = state.connectors;
        listening = state.automations.length > 0;
        // Hold a connection only while an enabled telegram listener automation exists (the state route already
        // filtered to those); no automations ⇒ release everything.
        const desired = new Map(
            listening ? connectors.filter(({ config }) => config.botToken !== "").map(({ id, config }) => [id, config] as const) : [],
        );
        // Deleting the current key during a Map iteration is safe (the iterator skips removed entries).
        for (const [id, botToken] of wired) {
            // A poll loop that hit a fatal error took itself out of the pool; dropping it here is what lets the
            // loop below re-open it once its backoff expires, instead of trusting a `wired` entry forever.
            if (desired.get(id)?.botToken !== botToken || telegramConnection(botToken) === undefined) {
                wired.delete(id);
                closeTelegramConnection(botToken);
            }
        }
        for (const [id, config] of desired) {
            if (wired.has(id) || connecting.has(id) || Date.now() < (fatalUntil.get(config.botToken) ?? 0)) {
                continue;
            }
            connecting.add(id);
            try {
                const connection = await openTelegramConnection(config.botToken);
                connection.listen(
                    (update) => listener.onUpdate(connection, update),
                    (error) => {
                        log.error({ err: error, capabilityId: id }, "telegram poll stopped");
                        fatalUntil.set(config.botToken, Date.now() + FATAL_RETRY_MS);
                        void daemon.failure(error.message);
                    },
                );
                fatalUntil.delete(config.botToken);
                wired.set(id, config.botToken);
            } catch (error) {
                log.error({ err: error, capabilityId: id }, "telegram connect failed");
                if (error instanceof FatalTelegramError) {
                    fatalUntil.set(config.botToken, Date.now() + FATAL_RETRY_MS);
                    await daemon.failure(error.message);
                }
            } finally {
                connecting.delete(id);
            }
        }
    };

    const postStatus = async (): Promise<void> => {
        const connections = connectors.map(({ id }) => {
            const botToken = wired.get(id);
            return {
                capabilityId: id,
                provider: "telegram",
                // idle = the gateway is up but has no enabled telegram listener automation to connect for; a
                // connection is held only while one exists (the discord/slack/imap gateways' hold predicate).
                gateway: !listening
                    ? "idle"
                    : botToken !== undefined && telegramConnection(botToken) !== undefined
                      ? "ready"
                      : connecting.has(id)
                        ? "connecting"
                        : "disconnected",
            };
        });
        await daemon.status({ connections });
    };

    // Loopback liveness surface only (no control routes — nothing drives this gateway): binds the panel
    // manager's assigned PORT so the operator can `curl /health` a suspect process.
    const server = createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        const ok = req.method === "GET" && path === "/health";
        res.writeHead(ok ? 200 : 404, { "content-type": "text/plain; charset=utf-8" });
        res.end(ok ? "ok" : "not found");
    });
    server.listen(port, "127.0.0.1", () => log.info({ port }, "telegram gateway health endpoint listening"));

    const shutdown = (): void => {
        for (const botToken of wired.values()) {
            closeTelegramConnection(botToken);
        }
        wired.clear();
        listener.stopAll();
        server.close();
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    // A managed stop is `tmux kill-session`, which delivers SIGHUP (the pty vanishing), not SIGTERM.
    process.on("SIGHUP", shutdown);

    await reconcile();
    setInterval(() => void reconcile(), RECONCILE_MS);
    await postStatus();
    setInterval(() => void postStatus(), STATUS_MS);
};

void main();
