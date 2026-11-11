import { createHash, randomBytes } from "node:crypto";
import { parseJsonOr } from "@intentic/base/json";
import { z } from "zod";
import { opt } from "../../opt.js";
import type { McpSession } from "./mcp-session.js";

// The OAuth client legs of an MCP sign-in: registering this sandbox with the authorization server (RFC 7591), the
// authorization request with PKCE and a resource indicator (OAuth 2.1, RFC 8707), and trading a code or a refresh token
// at the token endpoint. Each answers in data; only an unreachable endpoint throws.

const ANSWER_MS = 15_000;

// Who the sandbox is to one authorization server.
export type RegisteredClient = Pick<McpSession, "clientId" | "clientSecret" | "clientAuth">;

const RegistrationSchema = z.looseObject({
    client_id: z.string().min(1),
    client_secret: z.string().optional(),
    token_endpoint_auth_method: z.string().optional(),
});

const TokenAnswerSchema = z.looseObject({
    access_token: z.string().min(1),
    token_type: z.string().optional(),
    expires_in: z.coerce.number().optional(),
    refresh_token: z.string().optional(),
    scope: z.string().optional(),
    id_token: z.string().optional(),
});
export type TokenAnswer = z.infer<typeof TokenAnswerSchema>;

const OAuthErrorSchema = z.looseObject({ error: z.string(), error_description: z.string().optional() });

// What a refusal says, in the authorization server's own words where it gave any.
// A refusal's body, read once: its OAuth error code (RFC 6749 §5.2) and the sentence to show for it.
const refusalOf = async (response: Response): Promise<{ readonly code: string | undefined; readonly said: string }> => {
    const parsed = OAuthErrorSchema.safeParse(parseJsonOr(await response.text(), undefined));
    if (!parsed.success) {
        return { code: undefined, said: `HTTP ${response.status}` };
    }
    const { error, error_description } = parsed.data;
    return { code: error, said: error_description === undefined ? error : `${error}: ${error_description}` };
};

// A loopback callback is a native client's; anything else a web one (the spec's `application_type` guidance, so an
// OpenID server's redirect rules for the two never refuse the registration).
const applicationType = (redirectUri: string): "native" | "web" => {
    const host = URL.parse(redirectUri)?.hostname ?? "";
    return ["localhost", "127.0.0.1", "[::1]"].includes(host) ? "native" : "web";
};

export type Registration = { readonly client: RegisteredClient } | { readonly refused: string };

// Registers the sandbox as a public client with the one callback it lands on. A secret the server issues anyway is kept
// and used the way it says.
export const registerClient = async (
    endpoint: string,
    input: { readonly redirectUri: string; readonly clientName: string },
    fetchImpl: typeof fetch = fetch,
): Promise<Registration> => {
    const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
            client_name: input.clientName,
            redirect_uris: [input.redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            application_type: applicationType(input.redirectUri),
        }),
        signal: AbortSignal.timeout(ANSWER_MS),
    });
    if (!response.ok) {
        return { refused: (await refusalOf(response)).said };
    }
    // allow(silent-catch): a registration answer that is not JSON is refused below like one missing its client_id
    const parsed = RegistrationSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
        return { refused: "the registration answer named no client_id" };
    }
    const { client_id, client_secret, token_endpoint_auth_method } = parsed.data;
    const clientAuth = client_secret === undefined ? "none" : token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "client_secret_basic";
    return { client: { clientId: client_id, ...opt("clientSecret", client_secret), clientAuth } };
};

// PKCE (RFC 7636): the verifier stays in the daemon; only its S256 challenge goes into the browser's address.
export interface PkcePair {
    readonly verifier: string;
    readonly challenge: string;
}

export const pkcePair = (): PkcePair => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

export const authorizeUrl = (
    endpoint: string,
    input: {
        readonly clientId: string;
        readonly redirectUri: string;
        readonly state: string;
        readonly challenge: string;
        readonly resource: string;
        readonly scope: string | undefined;
    },
): string => {
    const url = new URL(endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", input.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("code_challenge", input.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", input.state);
    url.searchParams.set("resource", input.resource);
    if (input.scope !== undefined) {
        url.searchParams.set("scope", input.scope);
    }
    return url.toString();
};

export type TokenResult =
    | { readonly tokens: TokenAnswer }
    // `final`: the grant itself was refused (an expired or revoked refresh token, a used code), so only a new sign-in
    // helps; otherwise the endpoint failed in a way a later try may not.
    | { readonly refused: string; readonly final: boolean };

const FINAL_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client", "unsupported_grant_type", "invalid_scope"]);

// One request to the token endpoint, the client identifying itself the way it registered.
export const tokenRequest = async (
    client: RegisteredClient & Pick<McpSession, "tokenEndpoint">,
    form: Readonly<Record<string, string>>,
    fetchImpl: typeof fetch = fetch,
): Promise<TokenResult> => {
    const body = new URLSearchParams(form);
    const headers = new Headers({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" });
    if (client.clientAuth === "client_secret_basic" && client.clientSecret !== undefined) {
        const pair = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`;
        headers.set("authorization", `Basic ${Buffer.from(pair).toString("base64")}`);
    } else {
        body.set("client_id", client.clientId);
        if (client.clientAuth === "client_secret_post" && client.clientSecret !== undefined) {
            body.set("client_secret", client.clientSecret);
        }
    }
    const response = await fetchImpl(client.tokenEndpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(ANSWER_MS) });
    if (!response.ok) {
        const { code, said } = await refusalOf(response);
        return { refused: said, final: code === undefined ? response.status === 400 || response.status === 401 : FINAL_ERRORS.has(code) };
    }
    // allow(silent-catch): a token answer that is not JSON is refused below like one missing its access_token
    const parsed = TokenAnswerSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
        return { refused: "the token endpoint answered without an access_token", final: false };
    }
    if (parsed.data.token_type !== undefined && parsed.data.token_type.toLowerCase() !== "bearer") {
        return { refused: `the token endpoint issued a ${parsed.data.token_type} token, not a bearer token`, final: true };
    }
    return { tokens: parsed.data };
};

const IdClaimsSchema = z.looseObject({
    email: z.string().optional(),
    preferred_username: z.string().optional(),
    name: z.string().optional(),
});

// Who signed in, read off an OpenID id_token's claims for display alone. It came straight from the token endpoint over
// TLS, which OpenID Connect Core §3.1.3.7 accepts in place of checking its signature; nothing is granted on it.
export const accountOf = (tokens: TokenAnswer): string | undefined => {
    const payload = tokens.id_token?.split(".")[1];
    if (payload === undefined) {
        return undefined;
    }
    const claims = IdClaimsSchema.safeParse(parseJsonOr(Buffer.from(payload, "base64url").toString("utf8"), undefined));
    return claims.success ? (claims.data.email ?? claims.data.preferred_username ?? claims.data.name) : undefined;
};

// When a token answer's access token stops working, as epoch milliseconds; undefined when the server gave no lifetime.
export const expiryOf = (tokens: TokenAnswer, now: number): number | undefined =>
    tokens.expires_in === undefined || !Number.isFinite(tokens.expires_in) ? undefined : now + tokens.expires_in * 1000;
