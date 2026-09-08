import { runConnectorGateway } from "@intentic/connector-runtime";
import { type CardConfig, type Connection, connectionOf, fieldsOfConfig } from "./google/accounts.js";
import { openSession } from "./google/session.js";
import { type Watcher, startWatcher } from "./watch/poller.js";

// The Google Workspace watcher: a baked extension's autoStart process. Reconciles one poller per connected account
// against `/listeners/google/state`, dispatching new mail and imminent events as listener messages; the daemon itself
// holds no Google connection. Runs only while an automation names `google` as its source.

interface GoogleConnectorConfig extends CardConfig {
    readonly provider: string;
}

const connectionFor = (id: string, config: GoogleConnectorConfig): Connection => connectionOf(id, fieldsOfConfig(config));

// The connection's identity: durable credential plus the person it acts as. Also the key the fatal backoff is held
// under, so a poller that dies mid-life pauses that credential, not that slot.
const keyOf = (config: GoogleConnectorConfig): string => [config.mode, config.email, config.refreshToken, config.serviceAccountKey].join(" ");

void runConnectorGateway<GoogleConnectorConfig, Watcher>({
    provider: "google",
    create: (ctx, control) => ({
        // A card that cannot authenticate is not a connection to want; `gw` says so to the agent.
        desired: (connectors) =>
            connectors.filter(({ id, config }) => connectionFor(id, config).credential !== undefined).map(({ id, config }) => [id, config] as const),
        keyOf,
        open: async (id, config) => {
            const connection = connectionFor(id, config);
            const session = openSession(connection, process.env, ctx.workspaceRoot, Date.now);
            // Fails the open on a credential Google already refuses, instead of a poller that finds out later.
            await session.token();
            return startWatcher(ctx, connection, session, (detail) => control.markFatal(keyOf(config), detail));
        },
        close: (id, watcher) => watcher.stop(),
        alive: (id, watcher) => watcher.alive(),
    }),
});
