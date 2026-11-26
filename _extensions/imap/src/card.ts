// envSuffix from its subpath, not the package root: the root loads every schema in the contract.
import { envSuffix } from "@intentic/sandbox-contract/capability-env";
import type { OAuthSettings } from "./oauth.js";
import type { MailCredential, SmtpConfig } from "./send.js";

// One connected IMAP card. The agent's CLI knows a card only by the settings its manifest's `env` puts in the turn's
// environment, none of them a credential (IMAP_HOST_OFFICE for the card `office`); the extension's backend reads the
// whole card, credentials included, from the daemon with each call (server.ts).

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

/** The cards this turn's environment names, by the id their env suffix spells (`office` for IMAP_HOST_OFFICE). */
export const cardIdsFrom = (env: NodeJS.ProcessEnv): string[] =>
    Object.keys(env)
        .filter((key) => key.startsWith(PREFIX))
        .map((key) => key.slice(PREFIX.length).toLowerCase());

export const selectCard = (ids: readonly string[], wanted: string | undefined): string => {
    const found = wanted === undefined ? (ids.length === 1 ? ids[0] : undefined) : ids.find((id) => envSuffix(id) === envSuffix(wanted));
    if (found === undefined) {
        throw new Error(
            ids.length === 0
                ? "No IMAP mailbox is connected: add the IMAP card under Capabilities"
                : `Several IMAP mailboxes are connected: pass --account with one of ${ids.join(", ")}`,
        );
    }
    return found;
};

/**
 * The card as the daemon holds it (a tool call's card, or the connection read), with the defaults its manifest gives a
 * field left at its default, which is stored empty or not at all.
 */
export const cardFromConfig = (id: string, config: Readonly<Record<string, string>>): ImapCard => {
    const get = (key: string, fallback = ""): string => config[key] || fallback;
    return {
        id,
        host: get("host"),
        port: get("port", "993"),
        username: get("username"),
        password: get("password"),
        authMode: get("authMode", "password"),
        oauthProvider: get("oauthProvider", "microsoft"),
        oauthTenant: get("oauthTenant"),
        oauthClientId: get("oauthClientId"),
        oauthClientSecret: get("oauthClientSecret"),
        oauthRefreshToken: get("oauthRefreshToken"),
        accessToken: get("accessToken"),
        smtpHost: get("smtpHost"),
        smtpPort: get("smtpPort", "587"),
        smtpSecurity: get("smtpSecurity", "starttls"),
        smtpUsername: get("smtpUsername"),
        smtpPassword: get("smtpPassword"),
    };
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
