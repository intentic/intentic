import { join } from "node:path";
import { extensionRuntimeDir, type ListenerPairing } from "@intentic/sandbox-contract";
import { type GatewayHooks, GatewayRefusal, runConnectorGateway } from "@intentic/connector-runtime";
import {
    closeWhatsAppConnection,
    forgetWhatsAppConnection,
    openWhatsAppConnection,
    whatsappConnection,
    whatsappConnections,
    type WhatsAppConnection,
} from "./client.js";
import { createWhatsAppListener, WHATSAPP_MAX } from "./listener.js";

// WhatsApp gateway process: reconciles one paired session per capability, dispatches inbound messages and mention
// replies, and publishes each capability's pairing status via a loopback control surface for the `whatsapp` CLI.
// Connects while its connector exists, not only its automations, since pairing starts the moment a capability is added.

export interface WhatsAppConnectorConfig {
    readonly provider: string;
    readonly phoneNumber: string;
}

// Digits-only input becomes a DM JID for that number; anything already containing '@' passes through.
export const chatJidOf = (chat: string): string => (chat.includes("@") ? chat : `${chat.replaceAll(/\D/g, "")}@s.whatsapp.net`);

// Connection the control surface acts through; with multiple paired numbers, sends go out on whichever connected first.
const firstReady = (): WhatsAppConnection | undefined => [...whatsappConnections().values()].find((each) => each.phase() === "ready");

void runConnectorGateway<WhatsAppConnectorConfig, WhatsAppConnection>({
    provider: "whatsapp",
    connectWithoutAutomations: true,
    // Faster than other gateways' status cadence, so a fresh pairing code isn't delayed on the card.
    statusMs: 5_000,
    publishGatewayUrl: true,
    create: (ctx) => {
        const runtimeDir = join(ctx.workspaceRoot, extensionRuntimeDir("whatsapp"));
        const sessionDirOf = (capabilityId: string): string => join(runtimeDir, `session-${capabilityId}`);
        const mediaDir = join(runtimeDir, "media");
        const listener = createWhatsAppListener(ctx, whatsappConnections);

        const hooks: GatewayHooks<WhatsAppConnectorConfig, WhatsAppConnection> = {
            desired: (connectors) => connectors.filter(({ config }) => config.phoneNumber !== "").map(({ id, config }) => [id, config] as const),
            // Changing the phone number is treated as a different session: forgotten, not resumed.
            keyOf: (config) => config.phoneNumber,
            open: async (id, config) => {
                // Assigned once open() returns; the message callback closes over this binding and needs it defined
                // first.
                // oxlint-disable-next-line prefer-const -- the message callback passed into openWhatsAppConnection closes over this binding, so it has to exist before the call that assigns it.
                let connection: WhatsAppConnection | undefined;
                connection = await openWhatsAppConnection({
                    capabilityId: id,
                    phoneNumber: config.phoneNumber,
                    sessionDir: sessionDirOf(id),
                    log: ctx.log,
                    onMessage: (raw) => {
                        if (connection !== undefined) {
                            listener.onMessage(connection, raw);
                        }
                    },
                    onLoggedOut: (detail) => {
                        // Pool entry is already gone; `alive` releases the slot next tick and a fresh pairing begins.
                        void ctx.daemon.failure(detail);
                    },
                });
                return connection;
            },
            close: async (id, connection, reason) => {
                if (reason === "superseded") {
                    // Capability removed or repointed: unlink and wipe so a re-add pairs fresh rather than resuming.
                    await forgetWhatsAppConnection(id, sessionDirOf(id), ctx.log);
                    return;
                }
                if (reason === "shutdown") {
                    closeWhatsAppConnection(id);
                }
                // "dead" means the connection already logged itself out; nothing left to stop.
            },
            alive: (id) => whatsappConnection(id) !== undefined,
            // No fatal phase: a failed open simply retries, and an unpaired capability is normal, not an error.
            phase: (connector, view) => {
                const connection = whatsappConnection(connector.id);
                if (!view.anyDesired) {
                    return "idle";
                }
                if (connection?.phase() === "ready") {
                    return "ready";
                }
                // An up-but-unlinked socket reports "pairing", not "connecting": it needs the owner, not more waiting.
                if (connection?.phase() === "pairing") {
                    return "pairing";
                }
                return connection !== undefined || view.connecting ? "connecting" : "disconnected";
            },
            // Every unpaired capability gets an entry; an absent one must mean paired, not "about to have a code".
            statusExtras: () => {
                const pairing: Record<string, ListenerPairing> = {};
                for (const [id, connection] of whatsappConnections()) {
                    const state = connection.pairing();
                    if (state !== undefined) {
                        pairing[id] = state;
                    }
                }
                return Object.keys(pairing).length > 0 ? { pairing } : {};
            },
            // Daemon's outbound door for a chat conversation; uses the same first-ready pick as the CLI's /send.
            deliver: async (channelId, text) => {
                const connection = firstReady();
                if (connection === undefined) {
                    throw new GatewayRefusal("WhatsApp is not connected: pair the device from the capability card first.");
                }
                for (let base = 0; base < text.length; base += WHATSAPP_MAX) {
                    await connection.sendText(chatJidOf(channelId), text.slice(base, base + WHATSAPP_MAX));
                }
            },
            // Loopback control surface the `whatsapp` CLI drives; every response is a human-readable string the CLI
            // prints for the model.
            routes: async (req, body) => {
                const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
                if (req.method === "GET" && path === "/chats") {
                    const connection = firstReady();
                    if (connection === undefined) {
                        return { status: 503, body: "WhatsApp is not connected, pair the device from the capability card first." };
                    }
                    const chats = await connection.listChats();
                    return {
                        body:
                            chats.length === 0
                                ? "No chats seen yet. Groups appear once connected; direct chats appear after their first message."
                                : chats.map((chat) => `${chat.jid}\t${chat.kind}\t${chat.name}`).join("\n"),
                    };
                }
                if (req.method === "POST" && path === "/send") {
                    const { chat, text } = JSON.parse((await body()) || "{}") as { chat?: unknown; text?: unknown };
                    if (typeof chat !== "string" || chat === "" || typeof text !== "string" || text === "") {
                        return { status: 400, body: "chat and text required" };
                    }
                    const connection = firstReady();
                    if (connection === undefined) {
                        return { status: 503, body: "WhatsApp is not connected, pair the device from the capability card first." };
                    }
                    await connection.sendText(chatJidOf(chat), text);
                    return { body: `Sent to ${chatJidOf(chat)}.` };
                }
                if (req.method === "POST" && path === "/send-file") {
                    const { chat, path: filePath } = JSON.parse((await body()) || "{}") as { chat?: unknown; path?: unknown };
                    if (typeof chat !== "string" || chat === "" || typeof filePath !== "string" || filePath === "") {
                        return { status: 400, body: "chat and path required" };
                    }
                    const connection = firstReady();
                    if (connection === undefined) {
                        return { status: 503, body: "WhatsApp is not connected, pair the device from the capability card first." };
                    }
                    await connection.sendFile(chatJidOf(chat), filePath);
                    return { body: `Sent ${filePath} to ${chatJidOf(chat)}.` };
                }
                if (req.method === "POST" && path === "/download") {
                    const { id } = JSON.parse((await body()) || "{}") as { id?: unknown };
                    if (typeof id !== "string" || id === "") {
                        return { status: 400, body: "id required" };
                    }
                    for (const connection of whatsappConnections().values()) {
                        const written = await connection.download(id, mediaDir);
                        if (written !== undefined) {
                            return { body: written };
                        }
                    }
                    return { status: 404, body: "No downloadable media under that id, only recently received messages can be fetched." };
                }
                return undefined;
            },
            shutdown: (wired) => {
                for (const id of wired.keys()) {
                    closeWhatsAppConnection(id);
                }
                listener.stopAll();
            },
        };
        return hooks;
    },
});
