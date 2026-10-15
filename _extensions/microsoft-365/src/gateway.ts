import { runConnectorGateway, storeRefreshTokenAsExtension } from "@intentic/connector-runtime";
import { type Account, bindingOf, DEFAULT_AUTHORITY } from "./accounts.js";
import { tokenSession } from "./auth.js";
import { Graph } from "./graph.js";
import { type MailWatcher, watchMail } from "./watch.js";

// The Microsoft 365 watcher: a baked extension's autoStart process, one inbox poller per signed-in card, running only
// while an automation listens to `microsoft365`. It rotates refresh tokens like the CLI does and stores each rotation
// on the card through the daemon (the oauth-token route its manifest's `permissions.daemon` names).

interface Config extends Omit<Account, "id"> {
    readonly provider: string;
}

// The connection's identity, and the key a refused sign-in pauses it under. Not the refresh token: the watcher's own
// rotation would reopen it every hour. `signedInAt` moves on every interactive sign-in, which is what lifts a pause.
const keyOf = (config: Config): string =>
    JSON.stringify([
        config.tenantId,
        config.clientId,
        config.clientSecret ?? "",
        config.authority || DEFAULT_AUTHORITY,
        config.access ?? "",
        config.signedInAt ?? "",
    ]);

void runConnectorGateway<Config, MailWatcher>({
    provider: "microsoft365",
    create: (ctx, control) => ({
        desired: (connectors) =>
            connectors
                .filter(({ config }) => Boolean(config.tenantId && config.clientId && config.refreshToken))
                .map(({ id, config }) => [id, config] as const),
        keyOf,
        open: async (id, config) => {
            const account: Account = { ...config, id };
            let held = config.refreshToken ?? "";
            const token = tokenSession(account, async (refreshToken) => {
                // `superseded`: the CLI stored a newer one first. Microsoft keeps this one valid too, so the watcher
                // carries on with it.
                await storeRefreshTokenAsExtension(ctx.api, { id, binding: bindingOf(account), previous: held, refreshToken });
                held = refreshToken;
            });
            return watchMail(ctx, new Graph(account, token), (detail) => control.markFatal(keyOf(config), detail));
        },
        close: (_id, watcher) => watcher.stop(),
        alive: (_id, watcher) => watcher.alive(),
    }),
});
