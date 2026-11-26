import { createHash } from "node:crypto";
import type { RefreshTokenStored, RefreshTokenWrite } from "@intentic/connector-runtime";
import { type Account, bindingOf, DEFAULT_AUTHORITY } from "./accounts.js";
import { type Http, tokenSession } from "./auth.js";

// The backend's access tokens, one session per card, in memory only. A session lives while the card signs in as it did
// (tenant, app, cloud, access, secret, the moment of its last interactive sign-in) and still holds a refresh token the
// session knows: one it was opened with or rotated to itself. A new sign-in, or a rotation the inbox watcher stored
// first, opens a fresh one, so a run of commands neither mints on every call nor holds on to a token the card dropped.

interface Session {
    readonly key: string;
    readonly tokens: Set<string>;
    readonly token: () => Promise<string>;
}

export interface Sessions {
    // The bearer source for one card as the daemon handed it to this call.
    readonly tokenFor: (account: Account) => () => Promise<string>;
    readonly clear: () => void;
}

// Stores a rotated refresh token on the card through the daemon (storeRefreshTokenAsExtension).
export type StoreToken = (write: RefreshTokenWrite) => Promise<RefreshTokenStored>;

const keyOf = (account: Account): string =>
    JSON.stringify([
        account.tenantId,
        account.clientId,
        account.authority || DEFAULT_AUTHORITY,
        account.access ?? "",
        createHash("sha256")
            .update(account.clientSecret ?? "")
            .digest("hex"),
        account.signedInAt ?? "",
    ]);

export const createSessions = (store: StoreToken, http: Http): Sessions => {
    const sessions = new Map<string, Session>();
    return {
        tokenFor: (account) => {
            const key = keyOf(account);
            const current = account.refreshToken ?? "";
            const known = sessions.get(account.id);
            if (known !== undefined && known.key === key && known.tokens.has(current)) {
                return known.token;
            }
            const tokens = new Set([current]);
            const token = tokenSession(
                account,
                async (refreshToken, previous) => {
                    // `superseded`: the watcher stored a newer one first. Microsoft keeps this one valid too.
                    await store({ id: account.id, binding: bindingOf(account), previous, refreshToken });
                    tokens.add(refreshToken);
                },
                { http },
            );
            sessions.set(account.id, { key, tokens, token });
            return token;
        },
        clear: () => sessions.clear(),
    };
};
