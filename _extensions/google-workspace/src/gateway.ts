import { runConnectorGateway } from "@intentic/connector-runtime";
import { type CardConfig, type Connection, connectionOf, fieldsOfConfig } from "./google/accounts.js";
import { openSession } from "./google/session.js";
import { type Watcher, startWatcher } from "./watch/poller.js";

/* The Google Workspace watcher: a baked extension's autoStart process (contributes.processes). It reconciles
 * one poller per connected Google account against the daemon's /listeners/google/state, and dispatches new
 * inbox mail and imminent calendar events as listener messages. The daemon holds no Google connection, this
 * does. Reconcile, status, health and shutdown are the shared connector runtime; what is here is only what
 * Google IS to a watcher: an account is a connection, and a credential Google has stopped accepting is fatal
 * until the owner fixes the card.
 *
 * It runs only while an enabled automation names `google` as its source (the runtime's default), so an owner
 * who wanted the tools and not the watching pays for no polling at all. */

interface GoogleConnectorConfig extends CardConfig {
    readonly provider: string;
}

const connectionFor = (id: string, config: GoogleConnectorConfig): Connection => connectionOf(id, fieldsOfConfig(config));

/* The connection's identity: the durable credential plus the person it acts as. A rotated refresh token or a
 * re-pointed address must reconnect, and nothing else should, the read/write switch changes what `gw` will
 * do, not what the watcher watches. Also the key the fatal backoff is held under, so a poller that dies
 * mid-life pauses that CREDENTIAL rather than that slot. */
const keyOf = (config: GoogleConnectorConfig): string => [config.mode, config.email, config.refreshToken, config.serviceAccountKey].join(" ");

void runConnectorGateway<GoogleConnectorConfig, Watcher>({
    provider: "google",
    create: (ctx, control) => ({
        // A card that cannot authenticate is not a connection to want, `gw` says so to the agent's face, and
        // there is nobody here to say it to.
        desired: (connectors) =>
            connectors.filter(({ id, config }) => connectionFor(id, config).credential !== undefined).map(({ id, config }) => [id, config] as const),
        keyOf,
        open: async (id, config) => {
            const connection = connectionFor(id, config);
            const session = openSession(connection, process.env, ctx.workspaceRoot, Date.now);
            // Fail the open on a credential Google already refuses, rather than starting a poller that will
            // discover it a minute later: an open that throws is reported on the card, a silent poller is not.
            await session.token();
            return startWatcher(ctx, connection, session, (detail) => control.markFatal(keyOf(config), detail));
        },
        close: (id, watcher) => watcher.stop(),
        alive: (id, watcher) => watcher.alive(),
    }),
});
