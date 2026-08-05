import { z } from "zod";
import { parseResponse } from "../core/inputs.js";

// The slice of Authentik's REST API the per-app OIDC client binding uses, injected so the provider is
// unit-testable with a fake; the default `authentikApi` below talks to an Authentik server over native fetch
// with the bootstrap token (Bearer). Authentik models an OIDC client as an OAuth2 *Provider* (carrying the
// client_id/secret + redirect URIs) linked to an *Application* (carrying the public slug). Both are keyed by
// the app slug so create-or-update is idempotent. The exact v3 JSON shapes are confirmed at integration time;
// only the fields we read are validated.
export interface AuthentikClientSpec {
    readonly baseUrl: string;
    readonly token: string;
    readonly slug: string;
    readonly clientId: string;
    readonly clientSecret: string;
    // The consuming app's public domains; each becomes a regex redirect URI allowing any path under it.
    readonly redirectDomains: readonly string[];
}

export interface AuthentikApi {
    // GET /api/v3/core/applications/?slug= -> does the app's OIDC application exist yet?
    readonly findApplication: (args: { readonly baseUrl: string; readonly token: string; readonly slug: string }) => Promise<boolean>;
    // Create-or-update the OAuth2 provider (client_id/secret/redirects) + its application, by slug.
    readonly ensureClient: (spec: AuthentikClientSpec) => Promise<void>;
    // DELETE the application + provider (used by prune).
    readonly deleteClient: (args: { readonly baseUrl: string; readonly token: string; readonly slug: string }) => Promise<void>;
}

const listSchema = z.object({ results: z.array(z.object({ pk: z.union([z.number(), z.string()]) })) });
const scopeListSchema = z.object({ results: z.array(z.object({ pk: z.string(), scope_name: z.string() })) });

// A single fetch with the Bearer token; throws on a non-2xx status with the response body for context.
const call = async (method: string, baseUrl: string, token: string, path: string, body?: unknown): Promise<Response> => {
    const response = await fetch(`${baseUrl}/api/v3${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        // Bound a stalled connection (undici's default headers timeout is ~5 minutes).
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        throw new Error(`authentik ${method} ${path} failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    }
    return response;
};

const get = async (baseUrl: string, token: string, path: string): Promise<unknown> => (await call("GET", baseUrl, token, path)).json();

// The pk of the default flow with this slug — Authentik ships authorization + invalidation flows out of the box.
const flowPk = async (baseUrl: string, token: string, slug: string): Promise<string | number> => {
    const result = parseResponse(
        z.object({ pk: z.union([z.number(), z.string()]) }),
        await get(baseUrl, token, `/flows/instances/${slug}/`),
        "authentik flow",
    );
    return result.pk;
};

// The standard OIDC scope mappings (openid/email/profile) so the client's tokens carry the expected claims.
const scopePks = async (baseUrl: string, token: string): Promise<string[]> => {
    const result = parseResponse(scopeListSchema, await get(baseUrl, token, "/propertymappings/provider/scope/?page_size=100"), "authentik scopes");
    return result.results.filter((mapping) => ["openid", "email", "profile"].includes(mapping.scope_name)).map((mapping) => mapping.pk);
};

const firstPk = (value: unknown): string | number | undefined => parseResponse(listSchema, value, "authentik list").results[0]?.pk;
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const authentikApi: AuthentikApi = {
    findApplication: async ({ baseUrl, token, slug }) => firstPk(await get(baseUrl, token, `/core/applications/?slug=${slug}`)) !== undefined,
    ensureClient: async ({ baseUrl, token, slug, clientId, clientSecret, redirectDomains }) => {
        const [authorizationFlow, invalidationFlow, propertyMappings] = await Promise.all([
            flowPk(baseUrl, token, "default-provider-authorization-implicit-consent"),
            flowPk(baseUrl, token, "default-provider-invalidation-flow"),
            scopePks(baseUrl, token),
        ]);
        const providerBody = {
            name: slug,
            authorization_flow: authorizationFlow,
            invalidation_flow: invalidationFlow,
            client_type: "confidential",
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uris: redirectDomains.map((domain) => ({ matching_mode: "regex", url: `^https://${escapeRegex(domain)}/.*$` })),
            property_mappings: propertyMappings,
            sub_mode: "hashed_user_id",
        };
        const providerPk = firstPk(await get(baseUrl, token, `/providers/oauth2/?name=${slug}`));
        const provider =
            providerPk !== undefined
                ? await call("PUT", baseUrl, token, `/providers/oauth2/${providerPk}/`, providerBody)
                : await call("POST", baseUrl, token, "/providers/oauth2/", providerBody);
        const pk = parseResponse(z.object({ pk: z.union([z.number(), z.string()]) }), await provider.json(), "authentik provider").pk;
        const appBody = { name: slug, slug, provider: pk };
        if (await authentikApi.findApplication({ baseUrl, token, slug })) {
            await call("PATCH", baseUrl, token, `/core/applications/${slug}/`, { provider: pk });
        } else {
            await call("POST", baseUrl, token, "/core/applications/", appBody);
        }
    },
    deleteClient: async ({ baseUrl, token, slug }) => {
        await call("DELETE", baseUrl, token, `/core/applications/${slug}/`).catch(() => undefined);
        const providerPk = firstPk(await get(baseUrl, token, `/providers/oauth2/?name=${slug}`));
        if (providerPk !== undefined) {
            await call("DELETE", baseUrl, token, `/providers/oauth2/${providerPk}/`).catch(() => undefined);
        }
    },
};
