import { createServer, type IncomingMessage } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
    closeWhatsAppConnection,
    forgetWhatsAppConnection,
    openWhatsAppConnection,
    whatsappConnection,
    whatsappConnections,
    type WhatsAppConnection,
} from "./client.js";
import type { GatewayCtx } from "./context.js";
import { createDaemonClient, type WhatsAppConnectorConfig } from "./daemon.js";
import { createWhatsAppListener } from "./listener.js";
import { log } from "./log.js";

/* The WhatsApp gateway process: a baked extension's autoStart process (contributes.processes). It reconciles
 * one paired multi-device session per configured capability against the daemon's /listeners/whatsapp/state,
 * dispatches every inbound message (sending mention replies back into the chat), publishes each capability's
 * PAIRING CODE through the status route, and exposes a loopback control surface for the agent's `whatsapp`
 * CLI. The daemon holds no WhatsApp connection — this does.
 *
 * ONE DELIBERATE DIFFERENCE from the discord/slack/telegram hold predicate (connect only while an enabled
 * listener automation exists): this gateway connects while a CONNECTOR exists, automations or not. Three
 * reasons, all of them the session's nature rather than taste: pairing happens the moment the capability is
 * added (the card is showing a code and the phone is waiting for the link to come up), the agent's `whatsapp`
 * CLI sends through this socket and must work without any automation, and WhatsApp unlinks a device that
 * stays offline for weeks — a connection that only exists while automations do would quietly lose the pairing
 * the owner did. */

const RECONCILE_MS = 30_000;
// Status carries the pairing code the capability card renders, and a fresh code must not wait half a minute —
// faster cadence than the other gateways, still trivial traffic (a loopback POST).
const STATUS_MS = 5_000;

const requireEnv = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") {
        log.error({ name }, "missing required env — the gateway can't start");
        process.exit(1);
    }
    return value;
};

// "4915112345678" and "+49 151…" both mean the DM with that number; a full JID passes through untouched.
export const chatJidOf = (chat: string): string => (chat.includes("@") ? chat : `${chat.replaceAll(/\D/g, "")}@s.whatsapp.net`);

const readBody = async (req: IncomingMessage): Promise<string> => {
    let body = "";
    for await (const chunk of req) {
        body += chunk;
    }
    return body;
};

// The connection the control surface acts through. First-ready is the single-number common case; with several
// numbers paired, sends go out on whichever paired first — a per-capability pick is a follow-up if anyone runs two.
const firstReady = (): WhatsAppConnection | undefined => [...whatsappConnections().values()].find((each) => each.phase() === "ready");

const main = async (): Promise<void> => {
    const daemonBase = requireEnv("INTENTIC_DAEMON");
    const panelToken = requireEnv("INTENTIC_PANEL_TOKEN");
    const port = Number(requireEnv("PORT"));
    const workspaceRoot = requireEnv("INTENTIC_WORKSPACE");

    const runtimeDir = join(workspaceRoot, ".intentic", "extensions-runtime", "whatsapp");
    const sessionDirOf = (capabilityId: string): string => join(runtimeDir, `session-${capabilityId}`);
    const mediaDir = join(runtimeDir, "media");

    const daemon = createDaemonClient(daemonBase, panelToken);
    const ctx: GatewayCtx = { daemon, log };
    const listener = createWhatsAppListener(ctx, whatsappConnections);

    // The reconcile-owned view: which phone number each capability is currently paired for. A number edit means
    // a DIFFERENT phone — the old session is forgotten (logout + wipe), not resumed.
    const wired = new Map<string, string>();
    const connecting = new Set<string>();
    let connectors: ReadonlyArray<{ id: string; config: WhatsAppConnectorConfig }> = [];
    let desiredAtAll = false;

    const open = async (id: string, phoneNumber: string): Promise<void> => {
        // The connection reference the message callback closes over — assigned as soon as open() returns;
        // baileys delivers nothing before the socket finishes opening, so the gap is unobservable.
        let connection: WhatsAppConnection | undefined;
        connection = await openWhatsAppConnection({
            capabilityId: id,
            phoneNumber,
            sessionDir: sessionDirOf(id),
            log,
            onMessage: (raw) => {
                if (connection !== undefined) {
                    listener.onMessage(connection, raw);
                }
            },
            onLoggedOut: (detail) => {
                // The pool entry is already gone; dropping `wired` lets the next reconcile start a fresh
                // pairing, whose code the status loop then shows on the card.
                wired.delete(id);
                void daemon.failure(detail);
            },
        });
    };

    const reconcile = async (): Promise<void> => {
        const state = await daemon.state().catch((error: unknown) => {
            log.error({ err: error }, "listener state fetch failed");
            return undefined;
        });
        if (state === undefined) {
            return;
        }
        connectors = state.connectors;
        const desired = new Map(
            connectors.filter(({ config }) => config.phoneNumber !== "").map(({ id, config }) => [id, config.phoneNumber] as const),
        );
        desiredAtAll = desired.size > 0;
        for (const [id, phoneNumber] of wired) {
            const wanted = desired.get(id);
            if (wanted === undefined) {
                // The capability was removed: unlink from the phone and wipe the session, so Linked devices
                // stays clean and a re-add pairs fresh.
                wired.delete(id);
                await forgetWhatsAppConnection(id, sessionDirOf(id), log);
                continue;
            }
            if (wanted !== phoneNumber) {
                wired.delete(id);
                await forgetWhatsAppConnection(id, sessionDirOf(id), log);
                continue;
            }
            if (whatsappConnection(id) === undefined) {
                // The connection took itself out of the pool (logged out) — reopen below.
                wired.delete(id);
            }
        }
        for (const [id, phoneNumber] of desired) {
            if (wired.has(id) || connecting.has(id)) {
                continue;
            }
            connecting.add(id);
            try {
                await open(id, phoneNumber);
                wired.set(id, phoneNumber);
            } catch (error) {
                log.error({ err: error, capabilityId: id }, "whatsapp open failed");
            } finally {
                connecting.delete(id);
            }
        }
    };

    const postStatus = async (): Promise<void> => {
        const pairing: Record<string, string> = {};
        const connections = connectors.map(({ id }) => {
            const connection = whatsappConnection(id);
            const code = connection?.pairingCode();
            if (code !== undefined) {
                pairing[id] = code;
            }
            return {
                capabilityId: id,
                provider: "whatsapp",
                gateway: !desiredAtAll
                    ? "idle"
                    : connection?.phase() === "ready"
                      ? "ready"
                      : connection !== undefined || connecting.has(id)
                        ? "connecting"
                        : "disconnected",
            };
        });
        await daemon.status({ connections, ...(Object.keys(pairing).length > 0 ? { pairing } : {}) });
    };

    // The loopback control surface the agent's `whatsapp` CLI drives (address published via gateway.url, the
    // discord-voice pattern). Every response is a human-readable string — the CLI prints it for the model.
    const server = createServer((req, res) => {
        void (async (): Promise<void> => {
            const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
            const send = (body: string, status = 200): void => {
                res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
                res.end(body);
            };
            try {
                if (req.method === "GET" && path === "/health") {
                    return send("ok");
                }
                if (req.method === "GET" && path === "/chats") {
                    const connection = firstReady();
                    if (connection === undefined) {
                        return send("WhatsApp is not connected — pair the device from the capability card first.", 503);
                    }
                    const chats = await connection.listChats();
                    return send(
                        chats.length === 0
                            ? "No chats seen yet. Groups appear once connected; direct chats appear after their first message."
                            : chats.map((chat) => `${chat.jid}\t${chat.kind}\t${chat.name}`).join("\n"),
                    );
                }
                if (req.method === "POST" && path === "/send") {
                    const { chat, text } = JSON.parse((await readBody(req)) || "{}") as { chat?: unknown; text?: unknown };
                    if (typeof chat !== "string" || chat === "" || typeof text !== "string" || text === "") {
                        return send("chat and text required", 400);
                    }
                    const connection = firstReady();
                    if (connection === undefined) {
                        return send("WhatsApp is not connected — pair the device from the capability card first.", 503);
                    }
                    await connection.sendText(chatJidOf(chat), text);
                    return send(`Sent to ${chatJidOf(chat)}.`);
                }
                if (req.method === "POST" && path === "/send-file") {
                    const { chat, path: filePath } = JSON.parse((await readBody(req)) || "{}") as { chat?: unknown; path?: unknown };
                    if (typeof chat !== "string" || chat === "" || typeof filePath !== "string" || filePath === "") {
                        return send("chat and path required", 400);
                    }
                    const connection = firstReady();
                    if (connection === undefined) {
                        return send("WhatsApp is not connected — pair the device from the capability card first.", 503);
                    }
                    await connection.sendFile(chatJidOf(chat), filePath);
                    return send(`Sent ${filePath} to ${chatJidOf(chat)}.`);
                }
                if (req.method === "POST" && path === "/download") {
                    const { id } = JSON.parse((await readBody(req)) || "{}") as { id?: unknown };
                    if (typeof id !== "string" || id === "") {
                        return send("id required", 400);
                    }
                    for (const connection of whatsappConnections().values()) {
                        const written = await connection.download(id, mediaDir);
                        if (written !== undefined) {
                            return send(written);
                        }
                    }
                    return send("No downloadable media under that id — only recently received messages can be fetched.", 404);
                }
                return send("not found", 404);
            } catch (error) {
                log.error({ err: error }, "control request failed");
                return send(`error: ${error instanceof Error ? error.message : String(error)}`, 500);
            }
        })();
    });

    // Publish the control address for the CLI to read (the daemon injects nothing WhatsApp-specific into the
    // agent's environment — the CLI finds the gateway through this file).
    const urlFile = join(runtimeDir, "gateway.url");
    await mkdir(dirname(urlFile), { recursive: true });
    await writeFile(urlFile, `http://127.0.0.1:${port}`);
    server.listen(port, "127.0.0.1", () => log.info({ port }, "whatsapp gateway control surface listening"));

    const shutdown = (): void => {
        for (const id of wired.keys()) {
            closeWhatsAppConnection(id);
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
