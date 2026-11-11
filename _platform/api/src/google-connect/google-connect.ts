import { GOOGLE_CONNECT_CALLBACK_PATH, type GoogleConnectGrant } from "@intentic/api-contract";
import { GOOGLE_IDENTITY_SCOPES, type GoogleAccess, googleWorkspaceScopes } from "@intentic/sandbox-contract/oauth/google-workspace";
import { z } from "zod";
import type { Config } from "../config.js";

/* The platform's half of Connect Google: the three exchanges with Google that need the client secret, which never
 * leaves this process. Nothing here is stored: the consent URL is built, a code is traded once, a refresh token is
 * traded for an hour of access, and each answer goes back to whoever asked. Google's error bodies can echo what was
 * sent, so only their protocol `error` code leaves this module. */

const CONSENT_URL = `https://accounts.google.com/o/oauth2/v2/auth`;
const TOKEN_URL = `https://oauth2.googleapis.com/token`;

export type Http = (url: string, init: RequestInit) => Promise<Response>;

export const googleConnectEnabled = (config: Config): boolean =>
    config.googleWorkspace.clientId !== `` && config.googleWorkspace.clientSecret !== ``;

// The same URI on the consent and on the code exchange, or Google refuses the trade.
const redirectUriOf = (config: Config): string => new URL(GOOGLE_CONNECT_CALLBACK_PATH, config.webOrigin).toString();

export interface ConsentAsk {
    readonly access: GoogleAccess;
    readonly loginHint?: string | undefined;
    readonly state: string;
    readonly codeChallenge: string;
}

export const consentUrl = (config: Config, ask: ConsentAsk): string => {
    const query = new URLSearchParams({
        client_id: config.googleWorkspace.clientId,
        redirect_uri: redirectUriOf(config),
        response_type: `code`,
        scope: [...GOOGLE_IDENTITY_SCOPES, ...googleWorkspaceScopes(ask.access)].join(` `),
        // Offline plus a forced consent: without both, Google issues no refresh token to an account that approved
        // this client before, and the card would be left holding nothing that outlives the hour.
        access_type: `offline`,
        prompt: `consent`,
        state: ask.state,
        code_challenge: ask.codeChallenge,
        code_challenge_method: `S256`,
    });
    // Preselects the account the card already names; Google's chooser still lets the person pick another.
    if (ask.loginHint !== undefined && ask.loginHint !== ``) {
        query.set(`login_hint`, ask.loginHint);
    }
    return `${CONSENT_URL}?${query.toString()}`;
};

// Google refused, with its own protocol code (`invalid_grant`, `invalid_client`...), which the caller maps to words.
export class GoogleRefusal extends Error {
    constructor(
        readonly code: string,
        readonly status: number,
    ) {
        super(`Google refused: ${code}`);
    }
}

// Every field optional: a success and a refusal share the endpoint, and each caller asks for what it needs below.
const TokenAnswerSchema = z.object({
    error: z.string().optional(),
    access_token: z.string().optional(),
    expires_in: z.number().optional(),
    refresh_token: z.string().optional(),
    scope: z.string().optional(),
    id_token: z.string().optional(),
});
type TokenAnswer = z.infer<typeof TokenAnswerSchema>;

const tokenCall = async (http: Http, form: Record<string, string>): Promise<TokenAnswer> => {
    const response = await http(TOKEN_URL, {
        method: `POST`,
        redirect: `error`,
        signal: AbortSignal.timeout(30_000),
        headers: { "content-type": `application/x-www-form-urlencoded` },
        body: new URLSearchParams(form).toString(),
    });
    // allow(silent-catch): an unreadable body is judged by its status alone, below.
    const parsed = TokenAnswerSchema.safeParse(await response.json().catch(() => undefined));
    const body = parsed.success ? parsed.data : {};
    if (!response.ok) {
        throw new GoogleRefusal(body.error ?? `http_${response.status}`, response.status);
    }
    return body;
};

const IdClaimsSchema = z.object({ email: z.string() });

// The ID token came straight from Google's token endpoint over TLS, so its claims are read, not verified: the
// signature would only prove what the channel already does. Empty when it carries no address, for the owner to type.
export const emailOfIdToken = (idToken: string | undefined): string => {
    const payload = idToken?.split(`.`)[1];
    if (payload === undefined) {
        return ``;
    }
    try {
        const claims = IdClaimsSchema.safeParse(JSON.parse(Buffer.from(payload, `base64url`).toString(`utf8`)));
        return claims.success ? claims.data.email : ``;
    } catch {
        // allow(silent-catch): an ID token that is not JSON leaves the address for the owner to type.
        return ``;
    }
};

export const exchangeCode = async (config: Config, http: Http, code: string, codeVerifier: string): Promise<GoogleConnectGrant> => {
    const body = await tokenCall(http, {
        grant_type: `authorization_code`,
        client_id: config.googleWorkspace.clientId,
        client_secret: config.googleWorkspace.clientSecret,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUriOf(config),
    });
    if (body.refresh_token === undefined || body.refresh_token === ``) {
        // The consent asks for offline access with a forced prompt, so a missing token means it never completed.
        throw new GoogleRefusal(`no_refresh_token`, 502);
    }
    return {
        refreshToken: body.refresh_token,
        email: emailOfIdToken(body.id_token),
        scopes: (body.scope ?? ``).split(` `).filter((one) => one !== ``),
    };
};

export const refreshAccess = async (config: Config, http: Http, refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> => {
    const body = await tokenCall(http, {
        grant_type: `refresh_token`,
        client_id: config.googleWorkspace.clientId,
        client_secret: config.googleWorkspace.clientSecret,
        refresh_token: refreshToken,
    });
    if (body.access_token === undefined) {
        throw new GoogleRefusal(`no_access_token`, 502);
    }
    return { accessToken: body.access_token, expiresIn: body.expires_in ?? 3600 };
};
