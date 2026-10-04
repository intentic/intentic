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
import { createControlRoutes } from "./routes.js";

// WhatsApp gateway process: reconciles one paired session per capability, dispatches inbound messages and mention
// replies, and publishes each capability's pairing status via a loopback control surface for the `whatsapp` CLI.
// Connects while its connector exists, not only its automations, since pairing starts the moment a capability is added.

export interface WhatsAppConnectorConfig {
    readonly provider: string;
    readonly phoneNumber: string;
}

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
                // oxlint-disable-next-line prefer-const -- The callback assigns this binding later.
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
                const target = await connection.resolveChat(channelId);
                if (target.kind !== "jid") {
                    throw new GatewayRefusal(`No single WhatsApp chat matches ${channelId}.`);
                }
                for (let base = 0; base < text.length; base += WHATSAPP_MAX) {
                    await connection.sendText(target.jid, text.slice(base, base + WHATSAPP_MAX));
                }
            },
            // Loopback control surface the `whatsapp` CLI drives (routes.ts).
            routes: createControlRoutes({ ready: firstReady, connections: whatsappConnections, mediaDir, log: ctx.log }),
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
