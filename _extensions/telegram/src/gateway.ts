import { runConnectorGateway } from "@intentic/connector-runtime";
import { closeTelegramConnection, FatalTelegramError, openTelegramConnection, telegramConnection, telegramConnections } from "./client.js";
import { createTelegramListener } from "./listener.js";

// The Telegram gateway process: a baked extension's autoStart process (contributes.processes). It reconciles one
// long-polling connection per configured bot against the daemon's /listeners/telegram/state, dispatches every
// inbound message (painting mention replies back into the chat), and reports its liveness. The daemon holds no
// Telegram connection — this does. The reconcile/status/health/shutdown shell is the shared connector runtime;
// what's here is only what Telegram IS: a bot token is a connection, and a webhook conflict or revoked token is
// fatal until fixed on the BotFather side.

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
                        // The poll loop died mid-life (revoked token, a webhook claiming this bot's updates):
                        // the connection took itself out of the pool, so `alive` below lets the reconcile drop
                        // the slot — and the fatal mark keeps it from reopening until the backoff expires.
                        ctx.log.error({ err: error, capabilityId: id }, "telegram poll stopped");
                        control.markFatal(config.botToken, error.message);
                    },
                );
                return config.botToken;
            },
            close: (id, botToken) => closeTelegramConnection(botToken),
            alive: (id, botToken) => telegramConnection(botToken) !== undefined,
            fatal: (error) => (error instanceof FatalTelegramError ? error.message : undefined),
            shutdown: (wired) => {
                for (const botToken of wired.values()) {
                    closeTelegramConnection(botToken);
                }
                listener.stopAll();
            },
        };
    },
});
