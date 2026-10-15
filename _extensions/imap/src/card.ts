// envSuffix from its subpath, not the package root: the root loads every schema in the contract.
import { envSuffix } from "@intentic/sandbox-contract/capability-env";
import type { OAuthSettings } from "./oauth.js";
import type { MailCredential, SmtpConfig } from "./send.js";

// One connected IMAP card as the agent's CLI sees it: the per-instance env vars its manifest's `env` declares, each
// suffixed with the card's id (IMAP_HOST_OFFICE for the card `office`).

export interface ImapCard extends OAuthSettings {
    readonly id: string;
    readonly host: string;
    readonly port: string;
    readonly password: string;
    readonly authMode: string;
    readonly smtpHost: string;
    readonly smtpPort: string;
    readonly smtpSecurity: string;
    readonly smtpUsername: string;
    readonly smtpPassword: string;
}

const PREFIX = "IMAP_HOST_";

export const cardsFrom = (env: NodeJS.ProcessEnv): ImapCard[] =>
    Object.keys(env)
        .filter((key) => key.startsWith(PREFIX))
        .map((key) => {
            const suffix = key.slice(PREFIX.length);
            const get = (name: string): string => env[`${name}_${suffix}`] ?? "";
            return {
                id: suffix.toLowerCase(),
                host: get("IMAP_HOST"),
                port: get("IMAP_PORT") || "993",
                username: get("IMAP_USERNAME"),
                password: get("IMAP_PASSWORD"),
                authMode: get("IMAP_AUTH_MODE") || "password",
                oauthProvider: get("IMAP_OAUTH_PROVIDER"),
                oauthTenant: get("IMAP_OAUTH_TENANT"),
                oauthClientId: get("IMAP_OAUTH_CLIENT_ID"),
                oauthClientSecret: get("IMAP_OAUTH_CLIENT_SECRET"),
                oauthRefreshToken: get("IMAP_OAUTH_REFRESH_TOKEN"),
                accessToken: get("IMAP_ACCESS_TOKEN"),
                smtpHost: get("SMTP_HOST"),
                smtpPort: get("SMTP_PORT"),
                smtpSecurity: get("SMTP_SECURITY"),
                smtpUsername: get("SMTP_USERNAME"),
                smtpPassword: get("SMTP_PASSWORD"),
            };
        });

export const selectCard = (cards: readonly ImapCard[], wanted: string | undefined): ImapCard => {
    const found = wanted === undefined ? (cards.length === 1 ? cards[0] : undefined) : cards.find((card) => envSuffix(card.id) === envSuffix(wanted));
    if (found === undefined) {
        throw new Error(
            cards.length === 0
                ? "No IMAP mailbox is connected: add the IMAP card under Capabilities"
                : `Several IMAP mailboxes are connected: pass --account with one of ${cards.map((card) => card.id).join(", ")}`,
        );
    }
    return found;
};

export const usesOAuth = (card: ImapCard): boolean => card.authMode === "oauth2";

// The outgoing server: blank SMTP credentials reuse the IMAP login; under OAuth2 the same sign-in serves both.
export const smtpOf = (card: ImapCard, credential: MailCredential): SmtpConfig => ({
    host: card.smtpHost,
    port: Number(card.smtpPort || "587"),
    security: card.smtpSecurity === "tls" ? "tls" : "starttls",
    username: card.smtpUsername || card.username,
    credential: "password" in credential && card.smtpPassword !== "" ? { password: card.smtpPassword } : credential,
});
