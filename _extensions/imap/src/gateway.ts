import { runConnectorGateway } from "@intentic/connector-runtime";
import {
    FatalConnectionError,
    type ImapConnection,
    type ImapConnectorConfig,
    configKeyOf,
    desiredAccounts,
    openImapConnection,
} from "./connection.js";

// The IMAP gateway process: a baked extension's autoStart process (contributes.processes). It reconciles one
// imapflow connection per configured account against the daemon's /listeners/imap/state, watches each
// account's mailbox over IDLE, and dispatches normalized message/flags/expunge events. The daemon holds no
// IMAP connection, this does. The reconcile/status/health/shutdown shell is the shared connector runtime;
// what's here is only what IMAP IS: an account+mailbox is a connection, a bad credential is fatal until fixed,
// and a server-dropped connection heals through the watermark catch-up on the next tick's reconnect.

void runConnectorGateway<ImapConnectorConfig, ImapConnection>({
    provider: "imap",
    create: (ctx) => {
        // Connections that closed themselves (server drop, network): `alive` reports them so the reconcile
        // releases the slot and reopens it, the watermark catch-up recovers whatever arrived in the gap.
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
                // A self-closed connection has nothing left to stop; stop() is what supersede and shutdown owe.
                if (reason !== "dead") {
                    void connection.stop();
                }
            },
            alive: (id, connection) => !closed.has(connection),
            fatal: (error) => (error instanceof FatalConnectionError ? error.message : undefined),
            // `alive` answers "should the slot be released", which lags a drop by one tick; the status row asks
            // the client itself, so a dying connection reads "disconnected" the moment it dies.
            phase: (connector, view) =>
                !view.holding ? "idle" : view.handle?.usable() === true ? "ready" : view.connecting ? "connecting" : "disconnected",
        };
    },
});
