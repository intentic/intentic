import { runConnectorGateway } from "@intentic/connector-runtime";
import {
    FatalConnectionError,
    type ImapConnection,
    type ImapConnectorConfig,
    configKeyOf,
    desiredAccounts,
    openImapConnection,
} from "./connection.js";

// The IMAP gateway process (autoStart, contributes.processes): reconciles one imapflow connection per account, watches
// each mailbox over IDLE, and dispatches normalized events. A bad credential is fatal until fixed; a dropped connection
// heals through watermark catch-up on reconnect.

void runConnectorGateway<ImapConnectorConfig, ImapConnection>({
    provider: "imap",
    create: (ctx) => {
        // Connections that closed themselves (server drop, network); lets the reconcile loop release and reopen the
        // slot.
        const closed = new WeakSet<ImapConnection>();
        return {
            desired: (connectors) => desiredAccounts(connectors).map(({ id, config }) => [id, config] as const),
            keyOf: configKeyOf,
            open: async (id, config) => {
                const connection = await openImapConnection(ctx, id, config, {
                    onClose: () => {
                        closed.add(connection);
                    },
                });
                return connection;
            },
            close: (id, connection, reason) => {
                // A self-closed connection has nothing left to stop; stop() is owed only by supersede and shutdown.
                if (reason !== "dead") {
                    void connection.stop();
                }
            },
            alive: (id, connection) => !closed.has(connection),
            fatal: (error) => (error instanceof FatalConnectionError ? error.message : undefined),
            // `alive` lags a drop by one tick (releases the slot next reconcile); the status row asks the client
            // directly, so it reads disconnected immediately.
            phase: (connector, view) =>
                !view.holding ? "idle" : view.handle?.usable() === true ? "ready" : view.connecting ? "connecting" : "disconnected",
        };
    },
});
