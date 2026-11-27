import { runConnectorGateway } from "@intentic/connector-runtime";
import { closeTelegramConnection, FatalTelegramError, openTelegramConnection, type TelegramConnection, telegramConnection, telegramConnections } from "./client.js";
import { createTelegramListener } from "./listener.js";
import { StoredThreadsSchema, threadMemory } from "./threads.js";
import { ParkedSchema, parkBeforeSleep, WAKE_ROUTE, wakeWebhooks } from "./wake.js";

// Telegram gateway process (autoStart, contributes.processes): reconciles one long-poll connection per bot against
// /listeners/telegram/state; the daemon itself holds none. Shared connector runtime handles
// reconcile/status/health/shutdown; here is Telegram-specific: a token is a connection, revoked or conflicted is fatal.
// (2026-11-27) On a sandbox the platform hosts, right before it sleeps, the polls stop and each bot is pointed at the
// sandbox's wake door instead; the first poll after that clears the webhook again (wake.ts).

export interface TelegramConnectorConfig {
    readonly provider: string;
    readonly botToken: string;
    // How much of the agent's work a request's status card shows: "steps" (the default), "quiet" or "off".
    readonly progress?: string;
}

void runConnectorGateway<TelegramConnectorConfig, string>({
    provider: "telegram",
    create: (ctx, control) => {
        // The connectors as the last reconcile read them; a progress edit takes effect without reconnecting.
        let connectors: ReadonlyArray<{ readonly config: TelegramConnectorConfig }> = [];
        const progressOf = (connection: TelegramConnection): string | undefined => connectors.find(({ config }) => config.botToken === connection.botToken)?.config.progress;
        // Which reply chain each message belongs to, kept in the extension's state directory across restarts.
        const threads = threadMemory(
            ctx.api.document("threads.json", { parse: (raw) => StoredThreadsSchema.safeParse(raw).data, fallback: () => ({}) }),
            (error) => ctx.log.warn({ err: error }, "telegram: thread memory not saved or read"),
        );
        const listener = createTelegramListener(ctx, telegramConnections, { progressOf, threads });
        const wake = wakeWebhooks({
            parked: ctx.api.document("wake-webhooks.json", { parse: (raw) => ParkedSchema.safeParse(raw).data, fallback: () => ({}) }),
            wakeUrl: () => ctx.api.sleep.wakeUrl(WAKE_ROUTE),
            log: ctx.log,
        });
        const asleep = parkBeforeSleep(ctx.api.sleep, wake, { bots: () => [...telegramConnections().values()], close: closeTelegramConnection });
        return {
            // The token is the connection's key, so a token edit reconnects and a progress edit does not.
            desired: (entries) => {
                connectors = entries;
                return asleep() ? [] : entries.filter(({ config }) => config.botToken !== "").map(({ id, config }) => [id, config] as const);
            },
            keyOf: (config) => config.botToken,
            open: async (id, config) => {
                const connection = await openTelegramConnection(config.botToken, { reclaim: (call, conflict) => wake.reclaim(config.botToken, call, conflict) });
                // Opened while the bots were being pointed at the wake door: its poll would take the bot back from it.
                if (asleep()) {
                    closeTelegramConnection(config.botToken);
                    throw new Error("the sandbox is going to sleep");
                }
                connection.listen(
                    (update) => listener.onUpdate(connection, update),
                    (error) => {
                        // Poll loop died mid-life; the connection already left the pool (so `alive` reflects it), and
                        // the fatal mark blocks reopening until backoff expires.
                        ctx.log.error({ err: error, capabilityId: id }, "telegram poll stopped");
                        control.markFatal(config.botToken, error.message);
                    },
                    (error, waitMs) => ctx.log.warn({ err: error, capabilityId: id, waitMs }, "telegram poll failed; retrying"),
                );
                return config.botToken;
            },
            close: (id, botToken) => closeTelegramConnection(botToken),
            alive: (id, botToken) => telegramConnection(botToken) !== undefined,
            fatal: (error) => (error instanceof FatalTelegramError ? error.message : undefined),
            // Outbound door: a channel message posted through whichever connected bot accepts that chat, into the
            // conversation's reply chain when it lives in one.
            deliver: (channelId, text, thread) => listener.deliver(channelId, text, thread),
            shutdown: (wired) => {
                for (const botToken of wired.values()) {
                    closeTelegramConnection(botToken);
                }
            },
        };
    },
});
