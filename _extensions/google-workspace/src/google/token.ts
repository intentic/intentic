import { createSign } from "node:crypto";
import type { Connection, Credential } from "./accounts.js";
import { describe } from "./accounts.js";
import { scopesFor } from "./scopes.js";

// Mints the one-hour access token every request rides: a `user` card exchanges its refresh token, a `domain` card signs
// a JWT naming the person to act as in `sub`. `invalid_grant` gets a real explanation, since a Testing-status consent
// screen issues refresh tokens that die after 7 days.

export interface AccessToken {
    readonly token: string;
    // Epoch seconds; trusted only for the cache, not consulted per-request (that reacts to a 401 instead).
    readonly expiresAt: number;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ASSERTION_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");

// A signed JWT bearer assertion: the service account asks to become `subject` for one hour, with these scopes.
export const assertionFor = (credential: Extract<Credential, { mode: "domain" }>, subject: string, scopes: string[], now: number): string => {
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
        JSON.stringify({
            iss: credential.clientEmail,
            sub: subject,
            scope: scopes.join(" "),
            aud: credential.tokenUri,
            iat: now,
            exp: now + 3600,
        }),
    );
    const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(credential.privateKey);
    return `${header}.${claims}.${b64url(signature)}`;
};

const grantBody = (connection: Connection, credential: Credential, now: number): URLSearchParams => {
    if (credential.mode === "user") {
        return new URLSearchParams({
            grant_type: "refresh_token",
            client_id: credential.clientId,
            client_secret: credential.clientSecret,
            refresh_token: credential.refreshToken,
        });
    }
    return new URLSearchParams({
        grant_type: ASSERTION_GRANT,
        assertion: assertionFor(credential, connection.email, scopesFor(connection.access), now),
    });
};

// Google's token endpoint answers failures as `{error, error_description}`; each case here is something the owner does
// about the card, said as that rather than relayed raw.
export const tokenFailure = (connection: Connection, mode: Credential["mode"], error: string, description: string | undefined): string => {
    const who = describe(connection);
    if (error === "invalid_grant" && mode === "user") {
        return [
            `Google rejected the refresh token for "${who}".`,
            `Either it expired — an OAuth consent screen left in "Testing" issues refresh tokens that die after 7 days, so set it to "In production" —`,
            `or it was revoked (password change, six months idle, a hundredth token on the same client).`,
            `Get a fresh one and paste it onto the card.`,
        ].join(" ");
    }
    if (error === "invalid_grant" && mode === "domain") {
        return [
            `Google rejected the service account's request to act as ${connection.email} on "${who}".`,
            `The usual cause is domain-wide delegation: in admin.google.com the service account's client ID must be authorized for exactly the scopes this card asks for,`,
            `and ${connection.email} must be a real user in that domain.`,
        ].join(" ");
    }
    if (error === "invalid_client") {
        return `Google rejected the OAuth client on "${who}": check the client ID and secret came from the same credential in the console.`;
    }
    if (error === "unauthorized_client" && mode === "domain") {
        return `The service account on "${who}" is not authorized for these scopes. Add its client ID under Security → API controls → Domain-wide delegation in admin.google.com.`;
    }
    return `Google refused to issue a token for "${who}": ${error}${description === undefined ? "" : `, ${description}`}.`;
};

export const mintToken = async (connection: Connection, credential: Credential, now: number): Promise<AccessToken> => {
    const url = credential.mode === "user" ? TOKEN_URL : credential.tokenUri;
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: grantBody(connection, credential, now).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
        const error = typeof body["error"] === "string" ? body["error"] : `HTTP ${response.status}`;
        const description = typeof body["error_description"] === "string" ? body["error_description"] : undefined;
        throw new Error(tokenFailure(connection, credential.mode, error, description));
    }
    const token = body["access_token"];
    if (typeof token !== "string") {
        throw new Error(`Google's token endpoint answered without an access token for "${describe(connection)}".`);
    }
    const lifetime = typeof body["expires_in"] === "number" ? body["expires_in"] : 3600;
    return { token, expiresAt: now + lifetime };
};

// Exchanges an authorization code from the consent flow, `gw auth login`'s last step, and the only place a refresh
// token is created rather than read.
export const exchangeCode = async (
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
): Promise<{ refreshToken: string; scopes: string }> => {
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
        }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
        const error = typeof body["error"] === "string" ? body["error"] : `HTTP ${response.status}`;
        const description = typeof body["error_description"] === "string" ? `, ${body["error_description"]}` : "";
        throw new Error(`Google refused to exchange the authorization code: ${error}${description}.`);
    }
    const refreshToken = body["refresh_token"];
    if (typeof refreshToken !== "string") {
        // Google issues a refresh token only on first consent unless asked again; the flow always asks, so a missing
        // one means approval never completed.
        throw new Error("Google returned no refresh token. Run the login again and approve the consent screen to the end.");
    }
    return { refreshToken, scopes: typeof body["scope"] === "string" ? body["scope"] : "" };
};
