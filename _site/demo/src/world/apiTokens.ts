import type { ApiToken, ApiTokenMinted, ApiTokenScope, WalletPolicy } from "@intentic/api-contract";

// THE ACCOUNT'S KEYS AS LIVE STATE: its API tokens (Settings ▸ Tokens) and the caps its wallet signs under (the wallet
// capability's card pushes them here). A token's value exists only in the answer that minted it, as on the platform,
// which keeps a digest; here nothing keeps it at all.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// How many live tokens one account may hold (tokens.routes.ts `TOKEN_CEILING`).
const TOKEN_CEILING = 20;
// The real prefix (api-tokens.ts `API_TOKEN_PREFIX`) and its alphabet: no `-`, so a value never parses as a flag.
const PREFIX = `itk_`;
const ALPHABET = `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789`;

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
// Coarse to the minute, as the platform touches it.
const minute = (iso: string): string => `${iso.slice(0, 16)}:00.000Z`;

// The one the shop's fleet capability holds, so an agent in it can make sandboxes for the owner, and an older one from a
// laptop's CI script that nothing has presented in weeks: the case the page exists to show.
const tokens: ApiToken[] = [
    { id: `tok_7k2q9d`, label: `acme-shop fleet`, scope: `provision`, createdAt: ago(12 * DAY_MS), lastUsedAt: minute(ago(2 * HOUR_MS)) },
    { id: `tok_3m8w1x`, label: `ada-laptop ci`, scope: `provision`, createdAt: ago(41 * DAY_MS), lastUsedAt: minute(ago(23 * DAY_MS)) },
];

const secret = (length: number): string => Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => ALPHABET[byte % ALPHABET.length]).join(``);

/** token.list: the live tokens, newest first. */
export const tokenList = (): ApiToken[] => tokens.map((token) => ({ ...token }));

/** token.create: a new token, its value shown this once; undefined at the ceiling. */
export const mintToken = (label: string, scope: ApiTokenScope): ApiTokenMinted | undefined => {
    if (tokens.length >= TOKEN_CEILING) {
        return undefined;
    }
    const token: ApiToken = { id: `tok_${secret(6).toLowerCase()}`, label: label.trim(), scope, createdAt: new Date().toISOString() };
    tokens.unshift(token);
    return { ...token, token: `${PREFIX}${secret(32)}` };
};

/** token.revoke: the token stops working; an id that is not a live token changes nothing, as on the platform. */
export const revokeToken = (tokenId: string): void => {
    const index = tokens.findIndex((token) => token.id === tokenId);
    if (index >= 0) {
        tokens.splice(index, 1);
    }
};

// The caps the signer holds the wallet to. The card's own copy is the daemon's capability config, which the editor
// reads back; the platform's is only ever checked at a signature, which no demo payment reaches, so this is the copy.
let walletPolicy: WalletPolicy | undefined;

/** wallet.setPolicy: the caps the platform's signer will check every payment against, as written. */
export const writeWalletPolicy = (policy: WalletPolicy): WalletPolicy => {
    walletPolicy = { ...policy };
    return { ...walletPolicy };
};

