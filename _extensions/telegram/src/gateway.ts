import { runConnectorGateway } from "@intentic/connector-runtime";
import { closeTelegramConnection, FatalTelegramError, openTelegramConnection, telegramConnection, telegramConnections } from "./client.js";
import { createTelegramListener, deliverToChat } from "./listener.js";

// Telegram gateway process (autoStart, contributes.processes): reconciles one long-poll connection per bot against
// /listeners/telegram/state; the daemon itself holds none. Shared connector runtime handles
// reconcile/status/health/shutdown; here is Telegram-specific: a token is a connection, revoked or conflicted is fatal.

export interface TelegramConnectorConfig {
    readonly provider: string;
    readonly botToken: string;
}

void runConnectorGateway<TelegramConnectorConfig, string>({
    provider: "telegram",
    create: (ctx, control) => {
        const listener = createTelegramListener(ctx, telegramConnections);
        return {
            // The token IS the config key here (it is the only field), so an edit shows up as a different token.
            desired: (connectors) => connectors.filter(({ config }) => config.botToken !== "").map(({ id, config }) => [id, config] as const),
            keyOf: (config) => config.botToken,
            open: async (id, config) => {
                const connection = await openTelegramConnection(config.botToken);
                connection.listen(
                    (update) => listener.onUpdate(connection, update),
                    (error) => {
                        // Poll loop died mid-life; the connection already left the pool (so `alive` reflects it), and
                        // the fatal mark blocks reopening until backoff expires.
                        ctx.log.error({ err: error, capabilityId: id }, "telegram poll stopped");
                        control.markFatal(config.botToken, error.message);
                    },
                );
                return config.botToken;
            },
            close: (id, botToken) => closeTelegramConnection(botToken),
            alive: (id, botToken) => telegramConnection(botToken) !== undefined,
            fatal: (error) => (error instanceof FatalTelegramError ? error.message : undefined),
            // Outbound door: a channel message posted through whichever connected bot accepts that chat.
            deliver: (channelId, text) => deliverToChat(telegramConnections(), channelId, text),
            shutdown: (wired) => {
                for (const botToken of wired.values()) {
                    closeTelegramConnection(botToken);
                }
                listener.stopAll();
            },
        };
    },
});
