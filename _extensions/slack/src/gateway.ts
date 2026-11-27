import { runConnectorGateway } from "@intentic/connector-runtime";
import { closeSlackConnection, FatalSlackError, openSlackConnection, type SlackConnection, slackConnection, slackConnections } from "./client.js";
import { createSlackHttpIntake, GATEWAY_EVENTS_PATH } from "./http.js";
import { createSlackListener, deliverToChannel } from "./listener.js";
import { isHostedSandbox, slackModeOf } from "./mode.js";
import { tellSocketModeAsleep } from "./socket-notice.js";

// Slack gateway process (autoStart, contributes.processes): reconciles one connection per Slack card against
// /listeners/slack/state; the daemon itself holds no Slack connection. The shared connector runtime handles
// reconcile/status/health/shutdown; this file is Slack-specific: a card's tokens are a connection, a revoked one is
// fatal, and (2026-11-27) which way Slack reaches the app (mode.ts): Socket Mode's socket, or calls to
// the app's Request URL, which the extension's backend (server.ts) hands to this process's loopback (http.ts).

export interface SlackConnectorConfig {
    readonly provider: string;
    // The Web API credential (xoxb-): posting, reading, reacting.
    readonly botToken: string;
    // The app-level credential (xapp-, connections:write): opens the Socket Mode WebSocket.
    readonly appToken?: string;
    // (2026-11-27) The app's signing secret, which vouches for a call to its Request URL (HTTP mode).
    readonly signingSecret?: string;
    // How much of the agent's work a thread's status card shows: "steps" (the default), "quiet" or "off".
    readonly progress?: string;
    // How it shows: "card" (the default, a status card with Stop) or "native" (Slack's own streamed task list).
    readonly statusStyle?: string;
}

void runConnectorGateway<SlackConnectorConfig, string>({
    provider: "slack",
    // The backend finds the loopback here to hand on a call to the Request URL.
    publishGatewayUrl: true,
    create: (ctx) => {
        const hosted = isHostedSandbox();
        // The connectors as the last reconcile read them, undefined before the first; a progress edit takes effect without
        // reconnecting.
        let connectors: ReadonlyArray<{ readonly id: string; readonly config: SlackConnectorConfig }> | undefined;
        const configOf = (connection: SlackConnection): SlackConnectorConfig | undefined => connectors?.find(({ id }) => id === connection.id)?.config;
        const listener = createSlackListener(ctx, slackConnections, {
            progressOf: (connection) => configOf(connection)?.progress,
            styleOf: (connection) => configOf(connection)?.statusStyle,
        });
        const intake = createSlackHttpIntake({
            // Every card in HTTP mode, listening or not: a call it signed is acked either way.
            apps: () =>
                connectors?.flatMap(({ id, config }) =>
                    slackModeOf(config, hosted) === "http" && config.signingSecret !== undefined ? [{ id, signingSecret: config.signingSecret }] : [],
                ),
            connection: (id) => {
                const connection = slackConnection(id);
                return connection?.inbound.mode === "http" ? connection : undefined;
            },
            // The shell holds connections while an enabled Slack automation exists; a daemon that does not answer is
            // read as one, so Slack sends the call again rather than it being let go.
            listening: async () => {
                const state = await ctx.daemon.state().catch((error: Error) => {
                    ctx.log.warn({ err: error }, "slack: the listener state could not be read");
                    return undefined;
                });
                return state === undefined || state.automations.length > 0;
            },
            deliver: (connection, envelope) => listener.onEvent(connection, envelope),
            log: ctx.log,
        });
        return {
            desired: (entries) => {
                connectors = entries;
                return entries.filter(({ config }) => config.botToken !== "").map(({ id, config }) => [id, config] as const);
            },
            // Every credential keys the connection: a rotated one, or a signing secret pasted to leave Socket Mode, reconnects.
            keyOf: (config) => [slackModeOf(config, hosted) ?? "none", config.botToken, config.appToken ?? "", config.signingSecret ?? ""].join("\u0000"),
            open: async (id, config) => {
                const mode = slackModeOf(config, hosted);
                if (mode === undefined) {
                    throw new FatalSlackError(
                        "The Slack card holds no way for Slack to reach the sandbox: paste the app's Signing Secret (Request URLs) or its app-level xapp- token (Socket Mode)",
                    );
                }
                if (mode === "http") {
                    await openSlackConnection(id, config.botToken, { mode, signingSecret: config.signingSecret ?? "" });
                    return id;
                }
                const appToken = config.appToken ?? "";
                const connection = await openSlackConnection(id, config.botToken, { mode, appToken });
                if (connection.inbound.mode === "socket") {
                    connection.inbound.socket.on("slack_event", (envelope) => listener.onEvent(connection, envelope));
                }
                // An app set up before HTTP mode keeps answering while the sandbox is awake; its owner is told how to
                // have it answer while it sleeps too.
                if (hosted) {
                    tellSocketModeAsleep(ctx, appToken).catch((error: Error) => ctx.log.warn({ err: error }, `slack: telling the owner about Socket Mode failed: ${error.message}`));
                }
                return id;
            },
            close: async (id) => closeSlackConnection(id),
            alive: (id) => slackConnection(id) !== undefined,
            fatal: (error) => (error instanceof FatalSlackError ? error.message : undefined),
            // Outbound door: a channel message posted through whichever connected app accepts that channel, into the
            // conversation's thread when it lives in one.
            deliver: (channelId, text, thread) => deliverToChannel(slackConnections(), channelId, text, thread),
            // A call to the app's Request URL, as the backend received it at the public door and handed it on unread.
            routes: async (req, body) => {
                if (req.method !== "POST" || new URL(req.url ?? "/", "http://127.0.0.1").pathname !== GATEWAY_EVENTS_PATH) {
                    return undefined;
                }
                return intake.receive({ headers: req.headers, body: await body() });
            },
        };
    },
});
