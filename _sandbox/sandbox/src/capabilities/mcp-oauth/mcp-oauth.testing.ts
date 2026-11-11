import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

// A remote MCP server that authenticates the way the MCP authorization spec says, with its authorization server on the
// same origin, for the sign-in suites: protected-resource metadata, authorization-server metadata, dynamic client
// registration, an authorization code bound to its PKCE challenge, redirect and resource, and rotating refresh tokens.
// `approve` stands in for the person on the consent page. Not part of the build.

export interface FakeOAuthMcpOptions {
    // Whether the authorization server registers clients itself (RFC 7591).
    readonly registration?: boolean;
    // Whether it promises and sends `iss` with every answer (RFC 9207).
    readonly iss?: boolean;
    // How the 401 points at the protected-resource metadata: the header, the well-known address alone, or nothing at all
    // (the server's origin is then the authorization server).
    readonly metadata?: "header" | "well-known" | "none";
    // Seconds an access token lives.
    readonly accessTtl?: number;
}

export interface SeenRequest {
    readonly method: string;
    readonly path: string;
    readonly auth: string | undefined;
    readonly body: string;
}

// What a client asked to be registered as, by the fields a suite checks.
const RegistrationAskSchema = z.looseObject({
    client_name: z.string().optional(),
    redirect_uris: z.array(z.string()),
    grant_types: z.array(z.string()).optional(),
    token_endpoint_auth_method: z.string().optional(),
    application_type: z.string().optional(),
});
export type RegistrationAsk = z.infer<typeof RegistrationAskSchema>;

interface Issued {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly challenge: string;
    readonly resource: string;
    readonly scope: string | undefined;
}

export interface FakeOAuthMcp {
    readonly origin: string;
    // The MCP endpoint.
    readonly url: string;
    readonly seen: SeenRequest[];
    readonly registrations: RegistrationAsk[];
    // Tokens the MCP endpoint accepts now; a test revokes one by deleting it.
    readonly validAccess: Set<string>;
    // Every refresh token issued so far stops being honoured, as when the person revokes the app.
    readonly refuseRenewals: () => void;
    // The person approving on the consent page: the address the authorization server sends the browser back to.
    readonly approve: (authorizeUrl: string, answer?: { readonly error?: string; readonly iss?: string }) => URL;
    readonly close: () => Promise<void>;
}

const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
        let text = "";
        request.on("data", (chunk: Buffer) => {
            text += chunk.toString("utf8");
        });
        request.on("end", () => resolve(text));
    });

// `text` is already JSON; a key holding undefined was left out of it by JSON.stringify.
const json = (response: ServerResponse, status: number, text: string, headers: Readonly<Record<string, string>> = {}): void => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(text);
};

// An id_token as a test needs it: only the claims are read, for display.
const idToken = (claims: Record<string, string>): string =>
    `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

interface Reply {
    readonly status: number;
    readonly body: string;
}

export const startFakeOAuthMcp = async (options: FakeOAuthMcpOptions = {}): Promise<FakeOAuthMcp> => {
    const { registration = true, iss = true, metadata = "header", accessTtl = 3600 } = options;
    const seen: SeenRequest[] = [];
    const registrations: RegistrationAsk[] = [];
    const codes = new Map<string, Issued>();
    const validAccess = new Set<string>();
    const validRefresh = new Map<string, Issued>();
    let minted = 0;
    let origin = "";

    const issue = (grant: Issued) => {
        minted += 1;
        const access = `at-${minted}`;
        const refresh = `rt-${minted}`;
        validAccess.add(access);
        validRefresh.set(refresh, grant);
        return {
            access_token: access,
            token_type: "Bearer",
            expires_in: accessTtl,
            refresh_token: refresh,
            scope: grant.scope,
            id_token: idToken({ email: "ada@example.com" }),
        };
    };

    const token = (form: URLSearchParams): Reply => {
        const grant = form.get("grant_type");
        if (grant === "authorization_code") {
            const issued = codes.get(form.get("code") ?? "");
            codes.delete(form.get("code") ?? "");
            const challenge = createHash("sha256")
                .update(form.get("code_verifier") ?? "")
                .digest("base64url");
            const matches =
                issued !== undefined &&
                issued.clientId === form.get("client_id") &&
                issued.redirectUri === form.get("redirect_uri") &&
                issued.resource === form.get("resource") &&
                issued.challenge === challenge;
            return matches ? { status: 200, body: JSON.stringify(issue(issued)) } : { status: 400, body: JSON.stringify({ error: "invalid_grant" }) };
        }
        if (grant === "refresh_token") {
            const issued = validRefresh.get(form.get("refresh_token") ?? "");
            if (issued === undefined || issued.resource !== form.get("resource")) {
                return { status: 400, body: JSON.stringify({ error: "invalid_grant", error_description: "refresh token revoked" }) };
            }
            // Rotated: the one just used is spent.
            validRefresh.delete(form.get("refresh_token") ?? "");
            return { status: 200, body: JSON.stringify(issue(issued)) };
        }
        return { status: 400, body: JSON.stringify({ error: "unsupported_grant_type" }) };
    };

    const server = createServer((request, response) => {
        void readBody(request).then((body) => {
            const path = new URL(request.url ?? "/", origin).pathname;
            seen.push({ method: request.method ?? "GET", path, auth: request.headers.authorization, body });
            const bearer = request.headers.authorization?.replace(/^Bearer /, "");
            if (path === "/mcp") {
                if (bearer !== undefined && validAccess.has(bearer)) {
                    json(response, request.method === "POST" ? 200 : 405, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "fake" } } }), { "mcp-session-id": "s-1" });
                    return;
                }
                const named = metadata === "header" ? `, resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` : "";
                json(response, 401, JSON.stringify({ error: "unauthorized" }), { "www-authenticate": `Bearer realm="OAuth"${named}, scope="read"` });
                return;
            }
            if (path === "/.well-known/oauth-protected-resource/mcp" && metadata !== "none") {
                json(response, 200, JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read"], resource_name: "Fake MCP" }));
                return;
            }
            if (path === "/.well-known/oauth-authorization-server") {
                const described = {
                    issuer: origin,
                    authorization_endpoint: `${origin}/authorize`,
                    token_endpoint: `${origin}/token`,
                    registration_endpoint: registration ? `${origin}/register` : undefined,
                    scopes_supported: ["read", "write", "offline_access", "openid", "email"],
                    code_challenge_methods_supported: ["S256"],
                    authorization_response_iss_parameter_supported: iss,
                };
                json(response, 200, JSON.stringify(described));
                return;
            }
            if (path === "/register" && registration) {
                const asked = RegistrationAskSchema.parse(JSON.parse(body));
                registrations.push(asked);
                json(response, 201, JSON.stringify({ client_id: `client-${registrations.length}`, redirect_uris: asked.redirect_uris }));
                return;
            }
            if (path === "/token") {
                const answer = token(new URLSearchParams(body));
                json(response, answer.status, answer.body);
                return;
            }
            json(response, 404, JSON.stringify({ error: "not found" }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name.
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    return {
        origin,
        url: `${origin}/mcp`,
        seen,
        registrations,
        validAccess,
        refuseRenewals: () => validRefresh.clear(),
        approve: (authorizeUrl, answer = {}) => {
            const asked = new URL(authorizeUrl).searchParams;
            const back = new URL(asked.get("redirect_uri") ?? "");
            back.searchParams.set("state", asked.get("state") ?? "");
            if (answer.error !== undefined) {
                back.searchParams.set("error", answer.error);
            } else {
                const code = `code-${codes.size + 1}-${Date.now()}`;
                codes.set(code, {
                    clientId: asked.get("client_id") ?? "",
                    redirectUri: asked.get("redirect_uri") ?? "",
                    challenge: asked.get("code_challenge") ?? "",
                    resource: asked.get("resource") ?? "",
                    scope: asked.get("scope") ?? undefined,
                });
                back.searchParams.set("code", code);
            }
            const from = answer.iss ?? (iss ? origin : undefined);
            if (from !== undefined) {
                back.searchParams.set("iss", from);
            }
            return back;
        },
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
};
