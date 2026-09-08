import { runConnectorGateway } from "@intentic/connector-runtime";
import { closeSlackConnection, FatalSlackError, openSlackConnection, slackConnection, slackConnections } from "./client.js";
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
}

void runConnectorGateway<SlackConnectorConfig, string>({
    provider: "slack",
    create: (ctx) => {
        const listener = createSlackListener(ctx, slackConnections);
        return {
            desired: (connectors) =>
                connectors.filter(({ config }) => config.appToken !== "" && config.botToken !== "").map(({ id, config }) => [id, config] as const),
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
            // Outbound door: a channel message posted through whichever connected app accepts that channel.
            deliver: (channelId, text) => deliverToChannel(slackConnections(), channelId, text),
        };
    },
});
