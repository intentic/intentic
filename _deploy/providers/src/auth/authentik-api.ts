import { escapeRegExp } from "@intentic/base/escape";
import { FetchJsonError, type JsonResponse } from "@intentic/base/fetch-json";
import { z } from "zod";
import { parseResponse } from "../core/inputs.js";
import { vendorRequest } from "../core/rest-client.js";

// The slice of Authentik's REST API the per-app OIDC client binding uses. Authentik models an OIDC client as an
// OAuth2 Provider (client_id/secret + redirects) linked to an Application (public slug); both keyed by slug so
// create-or-update is idempotent.
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

// One call with the Bearer token; throws on a non-2xx status (bar the accepted ones) with the start of the response body,
// in the message shape this adapter has always used.
const send = async (method: string, baseUrl: string, token: string, path: string, body?: unknown, accept: readonly number[] = []): Promise<JsonResponse> => {
    try {
        return await vendorRequest(`${baseUrl}/api/v3${path}`, {
            method,
            headers: { Authorization: `Bearer ${token}` },
            json: body,
            accept,
            label: `authentik ${method} ${path}`,
        });
    } catch (error) {
        if (error instanceof FetchJsonError && error.kind === "status") {
            throw new Error(`authentik ${method} ${path} failed (${error.status}): ${error.body ?? ""}`, { cause: error });
        }
        throw error;
    }
};

const call = async (method: string, baseUrl: string, token: string, path: string, body?: unknown): Promise<unknown> =>
    (await send(method, baseUrl, token, path, body)).json;

// A delete whose target may already be gone: 404 is the desired end state, any other non-2xx throws.
const remove = async (baseUrl: string, token: string, path: string): Promise<void> => {
    await send("DELETE", baseUrl, token, path, undefined, [404]);
};

const get = async (baseUrl: string, token: string, path: string): Promise<unknown> => call("GET", baseUrl, token, path);

// The pk of the default flow with this slug. Authentik ships authorization + invalidation flows out of the box.
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
            redirect_uris: redirectDomains.map((domain) => ({ matching_mode: "regex", url: `^https://${escapeRegExp(domain)}/.*$` })),
            property_mappings: propertyMappings,
            sub_mode: "hashed_user_id",
        };
        const providerPk = firstPk(await get(baseUrl, token, `/providers/oauth2/?name=${slug}`));
        const provider =
            providerPk !== undefined
                ? await call("PUT", baseUrl, token, `/providers/oauth2/${providerPk}/`, providerBody)
                : await call("POST", baseUrl, token, "/providers/oauth2/", providerBody);
        const pk = parseResponse(z.object({ pk: z.union([z.number(), z.string()]) }), provider, "authentik provider").pk;
        const appBody = { name: slug, slug, provider: pk };
        if (await authentikApi.findApplication({ baseUrl, token, slug })) {
            await call("PATCH", baseUrl, token, `/core/applications/${slug}/`, { provider: pk });
        } else {
            await call("POST", baseUrl, token, "/core/applications/", appBody);
        }
    },
    deleteClient: async ({ baseUrl, token, slug }) => {
        await remove(baseUrl, token, `/core/applications/${slug}/`);
        const providerPk = firstPk(await get(baseUrl, token, `/providers/oauth2/?name=${slug}`));
        if (providerPk !== undefined) {
            await remove(baseUrl, token, `/providers/oauth2/${providerPk}/`);
        }
    },
};
