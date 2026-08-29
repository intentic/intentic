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

/* The WhatsApp gateway process: a baked extension's autoStart process (contributes.processes). It reconciles
 * one paired multi-device session per configured capability against the daemon's /listeners/whatsapp/state,
 * dispatches every inbound message (sending mention replies back into the chat), publishes WHERE EACH UNPAIRED
 * CAPABILITY'S CEREMONY STANDS through the status route, and exposes a loopback control surface for the agent's
 * `whatsapp` CLI. The daemon holds no WhatsApp connection, this does. The reconcile/status/health/shutdown shell is the
 * shared connector runtime; what's here is only what WhatsApp IS: a paired session per phone number, forgotten
 * (logout + wipe) rather than closed when its capability goes away, with a pairing code to surface while the
 * phone hasn't linked yet.
 *
 * ONE DELIBERATE DIFFERENCE from the discord/slack/telegram hold predicate (connect only while an enabled
 * listener automation exists): this gateway connects while a CONNECTOR exists, automations or not
 * (connectWithoutAutomations). Three reasons, all of them the session's nature rather than taste: pairing
 * happens the moment the capability is added (the card is showing a code and the phone is waiting for the link
 * to come up), the agent's `whatsapp` CLI sends through this socket and must work without any automation, and
 * WhatsApp unlinks a device that stays offline for weeks, a connection that only exists while automations do
 * would quietly lose the pairing the owner did. */

export interface WhatsAppConnectorConfig {
    readonly provider: string;
    readonly phoneNumber: string;
}

// "4915112345678" and "+49 151…" both mean the DM with that number; a full JID passes through untouched.
export const chatJidOf = (chat: string): string => (chat.includes("@") ? chat : `${chat.replaceAll(/\D/g, "")}@s.whatsapp.net`);

// The connection the control surface acts through. First-ready is the single-number common case; with several
// numbers paired, sends go out on whichever paired first, a per-capability pick is a follow-up if anyone runs two.
const firstReady = (): WhatsAppConnection | undefined => [...whatsappConnections().values()].find((each) => each.phase() === "ready");

void runConnectorGateway<WhatsAppConnectorConfig, WhatsAppConnection>({
    provider: "whatsapp",
    connectWithoutAutomations: true,
    // Status carries the pairing code the capability card renders, and a fresh code must not wait half a
    // minute, faster cadence than the other gateways, still trivial traffic (a loopback POST).
    statusMs: 5_000,
    publishGatewayUrl: true,
    create: (ctx) => {
        const runtimeDir = join(ctx.workspaceRoot, extensionRuntimeDir("whatsapp"));
        const sessionDirOf = (capabilityId: string): string => join(runtimeDir, `session-${capabilityId}`);
        const mediaDir = join(runtimeDir, "media");
        const listener = createWhatsAppListener(ctx, whatsappConnections);

        const hooks: GatewayHooks<WhatsAppConnectorConfig, WhatsAppConnection> = {
            desired: (connectors) => connectors.filter(({ config }) => config.phoneNumber !== "").map(({ id, config }) => [id, config] as const),
            // A number edit means a DIFFERENT phone, the old session is forgotten (logout + wipe), not resumed.
            keyOf: (config) => config.phoneNumber,
            open: async (id, config) => {
                // The connection reference the message callback closes over, assigned as soon as open() returns;
                // baileys delivers nothing before the socket finishes opening, so the gap is unobservable.
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
                        // The pool entry is already gone, so `alive` releases the slot next tick and a fresh
                        // pairing starts, whose code the status loop then shows on the card.
                        void ctx.daemon.failure(detail);
                    },
                });
                return connection;
            },
            close: async (id, connection, reason) => {
                if (reason === "superseded") {
                    // The capability was removed or repointed at a different phone: unlink from the phone and
                    // wipe the session, so Linked devices stays clean and a re-add pairs fresh.
                    await forgetWhatsAppConnection(id, sessionDirOf(id), ctx.log);
                    return;
                }
                if (reason === "shutdown") {
                    closeWhatsAppConnection(id);
                }
                // "dead" = the connection logged itself out of the pool; nothing left to stop.
            },
            alive: (id) => whatsappConnection(id) !== undefined,
            // No fatal classification: an open failure just retries next tick, a pairing that hasn't happened
            // yet is the NORMAL state of a fresh capability, not an error to back off from.
            phase: (connector, view) => {
                const connection = whatsappConnection(connector.id);
                if (!view.anyDesired) {
                    return "idle";
                }
                if (connection?.phase() === "ready") {
                    return "ready";
                }
                // A socket that is up but unlinked is NOT "connecting": nothing here is going to finish on its
                // own, and saying so is what puts the card in front of the one person who can finish it.
                if (connection?.phase() === "pairing") {
                    return "pairing";
                }
                return connection !== undefined || view.connecting ? "connecting" : "disconnected";
            },
            // Every unpaired capability, whether or not it is holding a code this second, see ListenerPairing:
            // an absent entry has to mean PAIRED, or the seconds before the first code read as connected.
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
            // The daemon's outbound door (shell route /deliver): a message the owner placed in a chat
            // conversation, sent through the paired session, the same first-ready pick the CLI's /send uses.
            deliver: async (channelId, text) => {
                const connection = firstReady();
                if (connection === undefined) {
                    throw new GatewayRefusal("WhatsApp is not connected: pair the device from the capability card first.");
                }
                for (let base = 0; base < text.length; base += WHATSAPP_MAX) {
                    await connection.sendText(chatJidOf(channelId), text.slice(base, base + WHATSAPP_MAX));
                }
            },
            // The loopback control surface the agent's `whatsapp` CLI drives (address published via
            // gateway.url). Every response is a human-readable string, the CLI prints it for the model.
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
