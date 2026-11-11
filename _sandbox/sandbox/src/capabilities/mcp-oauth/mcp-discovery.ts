import { errorMessage } from "@intentic/base/errors";
import { z } from "zod";

// What an MCP server asks of a client, read the way the MCP authorization spec (2026-07-28) says a client finds out:
// call it without a credential; a 401 names its protected-resource metadata (RFC 9728) in `WWW-Authenticate`, or the
// well-known URIs hold it; that names the authorization server, whose own metadata (RFC 8414, or OpenID discovery) says
// where to send the person and where to trade the code. Nothing here is stored or sent anywhere but those addresses.

const ANSWER_MS = 8_000;

// The authorization server's metadata, by the fields a sign-in reads.
export const AuthServerMetadataSchema = z.looseObject({
    issuer: z.string(),
    authorization_endpoint: z.string(),
    token_endpoint: z.string(),
    registration_endpoint: z.string().optional(),
    scopes_supported: z.array(z.string()).optional(),
    code_challenge_methods_supported: z.array(z.string()).optional(),
    authorization_response_iss_parameter_supported: z.boolean().optional(),
});
export type AuthServerMetadata = z.infer<typeof AuthServerMetadataSchema>;

const ProtectedResourceSchema = z.looseObject({
    resource: z.string(),
    authorization_servers: z.array(z.string()).min(1),
    scopes_supported: z.array(z.string()).optional(),
    resource_name: z.string().optional(),
});
type ProtectedResource = z.infer<typeof ProtectedResourceSchema>;

export type McpAuthDiscovery =
    | { readonly kind: "open" }
    // Refused without naming a usable sign-in: a token from the server's own settings is the way in. `detail` says why a
    // sign-in it does name cannot be used.
    | { readonly kind: "token"; readonly detail?: string }
    | { readonly kind: "unreachable"; readonly detail: string }
    | {
          readonly kind: "oauth";
          // The MCP server the tokens are for (RFC 8707 `resource`).
          readonly resource: string;
          readonly server: string;
          readonly scope: string | undefined;
          readonly metadata: AuthServerMetadata;
      };

// Authorization endpoints are HTTPS (OAuth 2.1 §1.5); plain http only on this machine's own loopback, where a test's
// stand-in or a local development server answers.
const secureEnough = (address: string): boolean => {
    const url = URL.parse(address);
    if (url === null) {
        return false;
    }
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
};

// The parameters of a `WWW-Authenticate` header's challenges, by name (RFC 9110 §11.6.1 auth-params, quoted or not).
const challengeParams = (header: string | null): ReadonlyMap<string, string> => {
    const params = new Map<string, string>();
    for (const match of (header ?? "").matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/g)) {
        const name = match[1]?.toLowerCase();
        const value = match[2]?.replace(/\\(.)/g, "$1") ?? match[3];
        if (name !== undefined && value !== undefined && !params.has(name)) {
            params.set(name, value);
        }
    }
    return params;
};

const getJson = async <T>(url: string, schema: z.ZodType<T>, fetchImpl: typeof fetch): Promise<T | undefined> => {
    if (!secureEnough(url)) {
        return undefined;
    }
    const asked = fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(ANSWER_MS) });
    // allow(silent-catch): an address that does not answer is a candidate that held nothing; the next one is tried
    const response = await asked.catch(() => undefined);
    if (response?.ok !== true) {
        await response?.body?.cancel();
        return undefined;
    }
    // allow(silent-catch): a body that is not JSON is a candidate that held no metadata
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    return parsed.success ? parsed.data : undefined;
};

// RFC 9728 §3.1: the well-known path is inserted between the host and the resource's path; the root form comes second.
const protectedResourceCandidates = (server: URL, named: string | undefined): readonly string[] => {
    if (named !== undefined) {
        return [named];
    }
    const path = server.pathname.replace(/\/+$/, "");
    const root = `${server.origin}/.well-known/oauth-protected-resource`;
    return path === "" ? [root] : [`${root}${path}`, root];
};

// The metadata must describe the server that was asked (RFC 9728 §3.3), or another origin could claim to be its
// authorization's source. Some servers name their origin rather than the endpoint's full path, so a prefix holds.
const describes = (metadata: ProtectedResource, server: URL): boolean => {
    const resource = URL.parse(metadata.resource);
    if (resource === null || resource.origin !== server.origin) {
        return false;
    }
    const prefix = resource.pathname.replace(/\/+$/, "");
    return server.pathname === prefix || server.pathname.startsWith(`${prefix}/`);
};

// The order the MCP spec gives (RFC 8414 §3.1 path insertion, then OpenID discovery inserted and appended).
const authServerCandidates = (issuer: URL): readonly string[] => {
    const path = issuer.pathname.replace(/\/+$/, "");
    if (path === "") {
        return [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`];
    }
    return [
        `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
        `${issuer.origin}/.well-known/openid-configuration${path}`,
        `${issuer.origin}${path}/.well-known/openid-configuration`,
    ];
};

export type AuthServerAnswer = { readonly metadata: AuthServerMetadata } | { readonly unusable: string } | undefined;

// The authorization server's metadata, validated as the spec requires before anything is sent to it: its `issuer` is the
// one asked about, character for character, its endpoints are HTTPS, and it does PKCE with S256. Undefined when no
// candidate address holds any.
const authServerMetadata = async (issuer: string, fetchImpl: typeof fetch = fetch): Promise<AuthServerAnswer> => {
    const base = URL.parse(issuer);
    if (base === null || !secureEnough(issuer)) {
        return undefined;
    }
    for (const candidate of authServerCandidates(base)) {
        const metadata = await getJson(candidate, AuthServerMetadataSchema, fetchImpl);
        if (metadata === undefined) {
            continue;
        }
        if (metadata.issuer !== issuer) {
            return { unusable: `${base.host} published metadata for a different issuer (${metadata.issuer}), which a client must not use` };
        }
        if (!secureEnough(metadata.authorization_endpoint) || !secureEnough(metadata.token_endpoint)) {
            return { unusable: `${base.host} signs in over plain http, which a client must not use` };
        }
        if (metadata.code_challenge_methods_supported?.includes("S256") !== true) {
            return { unusable: `${base.host} does not offer PKCE (S256), which the MCP authorization spec requires of a sign-in` };
        }
        return { metadata };
    }
    return undefined;
};

// What the sign-in asks for (the spec's scope selection): the challenge's own scope, else everything the resource lists.
// `offline_access` joins when the authorization server offers it, so a refresh token is more likely; `openid` and
// `email` join when offered too, so the form can say who signed in. Neither reaches the MCP server's own data.
const scopeFor = (challenged: string | undefined, resource: ProtectedResource | undefined, metadata: AuthServerMetadata): string | undefined => {
    const asked = (challenged ?? resource?.scopes_supported?.join(" ") ?? "").split(/\s+/).filter((word) => word !== "");
    const offered = new Set(metadata.scopes_supported ?? []);
    const extras = ["offline_access", "openid", "email"].filter((word) => offered.has(word) && !asked.includes(word));
    // Identity scopes alone, with nothing the resource asked for, would narrow a server that wanted no scope at all.
    const words = asked.length === 0 ? [] : [...asked, ...extras];
    return words.length === 0 ? undefined : words.join(" ");
};

const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "intentic", version: "1" } },
});

// Asks the server what it needs, and follows a sign-in it names to an authorization server a client may use.
export const discoverMcpAuth = async (url: string, fetchImpl: typeof fetch = fetch): Promise<McpAuthDiscovery> => {
    const server = URL.parse(url);
    if (server === null) {
        return { kind: "unreachable", detail: "that is not an address" };
    }
    let response: Response;
    try {
        response = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: initialize,
            signal: AbortSignal.timeout(ANSWER_MS),
        });
    } catch (error) {
        return { kind: "unreachable", detail: `${server.host} did not answer (${errorMessage(error)})` };
    }
    await response.body?.cancel();
    const challenge = challengeParams(response.headers.get("www-authenticate"));
    if (response.status >= 500) {
        return { kind: "unreachable", detail: `${server.host} answered ${response.status}` };
    }
    if (response.status !== 401 && !(response.status === 403 && challenge.has("resource_metadata"))) {
        return { kind: "open" };
    }
    const resource = await firstProtectedResource(server, challenge.get("resource_metadata"), fetchImpl);
    // Without protected-resource metadata, the earlier revisions' rule: the server's own origin is its authorization
    // server (some hosted servers still publish nothing else).
    const issuer = resource?.authorization_servers[0] ?? server.origin;
    const found = await authServerMetadata(issuer, fetchImpl);
    if (found === undefined) {
        return { kind: "token" };
    }
    if ("unusable" in found) {
        return { kind: "token", detail: found.unusable };
    }
    const canonical = `${server.origin}${server.pathname.replace(/\/+$/, "")}`;
    return {
        kind: "oauth",
        resource: resource?.resource ?? canonical,
        server: resource?.resource_name ?? new URL(found.metadata.issuer).host,
        scope: scopeFor(challenge.get("scope"), resource, found.metadata),
        metadata: found.metadata,
    };
};

const firstProtectedResource = async (server: URL, named: string | undefined, fetchImpl: typeof fetch): Promise<ProtectedResource | undefined> => {
    for (const candidate of protectedResourceCandidates(server, named)) {
        const metadata = await getJson(candidate, ProtectedResourceSchema, fetchImpl);
        if (metadata !== undefined && describes(metadata, server)) {
            return metadata;
        }
    }
    return undefined;
};
