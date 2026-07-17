import { createServer } from "node:http";
import { FatalConnectionError, type ImapConnection, configKeyOf, desiredAccounts, openImapConnection } from "./connection.js";
import type { GatewayCtx } from "./context.js";
import { type ImapConnectorConfig, createDaemonClient } from "./daemon.js";
import { log } from "./log.js";

// The IMAP gateway process: a baked extension's autoStart process (contributes.processes). It reconciles one
// imapflow connection per configured account against the daemon's /listeners/imap/state, watches each
// account's mailbox over IDLE, and dispatches normalized message/flags/expunge events. The daemon holds no
// IMAP connection — this does.

// A fatal connect (bad credential / bad mailbox) pauses that config's reconnect this long; a portal-side fix
// must heal unattended, so it's not sticky forever.
const FATAL_RETRY_MS = 300_000;
const RECONCILE_MS = 30_000;
const STATUS_MS = 30_000;
// A wedged logout must not hold shutdown hostage — the daemon's stop is `tmux kill-session`.
const STOP_TIMEOUT_MS = 3_000;

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
    const workspaceRoot = process.env["INTENTIC_WORKSPACE"] ?? "/work";

    const daemon = createDaemonClient(daemonBase, panelToken);
    const ctx: GatewayCtx = { daemon, workspaceRoot, log };

    // The reconcile-owned view of connected accounts + the latest connectors (status reporting reads both).
    const slots = new Map<string, { key: string; connection: ImapConnection }>();
    const connecting = new Set<string>();
    const fatalUntil = new Map<string, number>();
    let connectors: ReadonlyArray<{ id: string; config: ImapConnectorConfig }> = [];
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
        const desired = new Map(desiredAccounts(state).map((account) => [account.id, account.config]));
        // Deleting the current key during a Map iteration is safe (the iterator skips removed entries).
        for (const [id, slot] of slots) {
            const config = desired.get(id);
            if (config === undefined || configKeyOf(config) !== slot.key) {
                slots.delete(id);
                void slot.connection.stop();
            }
        }
        for (const [id, config] of desired) {
            const key = configKeyOf(config);
            if (slots.has(id) || connecting.has(id) || Date.now() < (fatalUntil.get(key) ?? 0)) {
                continue;
            }
            connecting.add(id);
            try {
                const connection = await openImapConnection(ctx, id, config, {
                    onClose: () => {
                        // The server or network dropped us — release the slot so the next tick reconnects,
                        // and the watermark catch-up recovers whatever arrived in the gap.
                        if (slots.get(id)?.connection === connection) {
                            slots.delete(id);
                        }
                    },
                });
                fatalUntil.delete(key);
                slots.set(id, { key, connection });
            } catch (error) {
                log.error({ err: error, capabilityId: id }, "imap connect failed");
                if (error instanceof FatalConnectionError) {
                    fatalUntil.set(key, Date.now() + FATAL_RETRY_MS);
                    await daemon.failure(error.message);
                }
            } finally {
                connecting.delete(id);
            }
        }
    };

    const postStatus = async (): Promise<void> => {
        const connections = connectors.map(({ id }) => ({
            capabilityId: id,
            provider: "imap",
            // idle = the gateway is up but has no enabled imap listener automation to connect for; a
            // connection is held only while one exists (the discord gateway's hold predicate).
            gateway: !listening
                ? "idle"
                : (slots.get(id)?.connection.usable() ?? false)
                  ? "ready"
                  : connecting.has(id)
                    ? "connecting"
                    : "disconnected",
        }));
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
    server.listen(port, "127.0.0.1", () => log.info({ port }, "imap gateway health endpoint listening"));

    const shutdown = (): void => {
        const stops = [...slots.values()].map((slot) => slot.connection.stop());
        slots.clear();
        void Promise.race([Promise.allSettled(stops), new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS))]).finally(() => {
            server.close();
            process.exit(0);
        });
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
