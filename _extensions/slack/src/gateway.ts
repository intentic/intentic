import { runConnectorGateway } from "@intentic/connector-runtime";
import { closeSlackConnection, FatalSlackError, openSlackConnection, type SlackConnection, slackConnection, slackConnections } from "./client.js";
import { createSlackListener, deliverToChannel } from "./listener.js";

// Slack gateway process (autoStart, contributes.processes): reconciles one socket per app against
// /listeners/slack/state; the daemon itself holds no Slack connection. The shared connector runtime handles
// reconcile/status/health/shutdown; this file is Slack-specific: a token pair is a connection, a revoked one is fatal.

export interface SlackConnectorConfig {
    readonly provider: string;
    // The Web API credential (xoxb-): posting, reading, reacting.
    readonly botToken: string;
    // The app-level credential (xapp-, connections:write): opens the Socket Mode WebSocket.
    readonly appToken: string;
    // How much of the agent's work a thread's status card shows: "steps" (the default), "quiet" or "off".
    readonly progress?: string;
    // How it shows: "card" (the default, a status card with Stop) or "native" (Slack's own streamed task list).
    readonly statusStyle?: string;
}

void runConnectorGateway<SlackConnectorConfig, string>({
    provider: "slack",
    create: (ctx) => {
        // The connectors as the last reconcile read them; a progress edit takes effect without reconnecting.
        let connectors: ReadonlyArray<{ readonly config: SlackConnectorConfig }> = [];
        const configOf = (connection: SlackConnection): SlackConnectorConfig | undefined => connectors.find(({ config }) => config.appToken === connection.appToken)?.config;
        const listener = createSlackListener(ctx, slackConnections, {
            progressOf: (connection) => configOf(connection)?.progress,
            styleOf: (connection) => configOf(connection)?.statusStyle,
        });
        return {
            desired: (entries) => {
                connectors = entries;
                return entries.filter(({ config }) => config.appToken !== "" && config.botToken !== "").map(({ id, config }) => [id, config] as const);
            },
            // Both tokens key the connection: a bot-token rotation must reconnect even with the same app token.
            keyOf: (config) => `${config.appToken}\u0000${config.botToken}`,
            open: async (id, config) => {
                const connection = await openSlackConnection(config.appToken, config.botToken);
                connection.socket.on("slack_event", (envelope) => listener.onEvent(connection, envelope));
                return config.appToken;
            },
            close: async (id, appToken) => closeSlackConnection(appToken),
            alive: (id, appToken) => slackConnection(appToken) !== undefined,
            fatal: (error) => (error instanceof FatalSlackError ? error.message : undefined),
            // Outbound door: a channel message posted through whichever connected app accepts that channel, into the
            // conversation's thread when it lives in one.
            deliver: (channelId, text, thread) => deliverToChannel(slackConnections(), channelId, text, thread),
        };
    },
});
