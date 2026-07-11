import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import type { AuthentikApi } from "./authentik-api.js";
import { authentikApi } from "./authentik-api.js";

// No SSH: this binding talks to Authentik's REST API over HTTP at its public url (like the Komodo deployment
// provider), so it carries the url + bootstrap token instead of an ssh block.
const clientSchema = z.object({
    authentikUrl: z.string(),
    bootstrapToken: z.string(),
    // The auth instance's public domain, for the issuer URL the app receives.
    domain: z.string(),
    // The app's OIDC application slug + the generated client credentials set on the provider.
    slug: z.string(),
    clientId: z.string(),
    clientSecret: z.string(),
    redirectDomains: z.array(z.string()).default([]),
});
type ClientInputs = z.infer<typeof clientSchema>;
const parse = (inputs: ResolvedInputs): ClientInputs => parseInputs(clientSchema, inputs, "authentik-client");

// Authentik mounts each OAuth2 provider's OIDC endpoints under its application slug; this is the issuer the
// app's OIDC library discovers (…/.well-known/openid-configuration lives beneath it).
const issuer = (parsed: ClientInputs): string => `https://${parsed.domain}/application/o/${parsed.slug}/`;
const outputsFor = (parsed: ClientInputs): Record<string, unknown> => ({
    issuer: issuer(parsed),
    clientId: parsed.clientId,
    clientSecret: parsed.clientSecret,
});

// A per-app OIDC client on a shared Authentik instance (the binding for an app that uses an auth capability).
// read reports it present once the application exists (so the noop re-derives the issuer + the generated
// client credentials); apply create-or-updates the OAuth2 provider + application idempotently by slug; delete
// removes both. client_id/secret are intentic-generated and set on the provider, so the outputs are stable
// without reading anything back.
export const createAuthentikClientProvider = (api: AuthentikApi = authentikApi): Provider => ({
    read: async (inputs, ctx) => {
        const parsed = parse(inputs);
        try {
            const exists = await api.findApplication({ baseUrl: parsed.authentikUrl, token: parsed.bootstrapToken, slug: parsed.slug });
            return exists ? { outputs: outputsFor(parsed) } : undefined;
        } catch (error) {
            ctx.log(`authentik-client "${ctx.id}": authentik not reachable yet, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    // The slug + generated credentials never drift, so a present application is a noop.
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parse(inputs);
        await api.ensureClient({
            baseUrl: parsed.authentikUrl,
            token: parsed.bootstrapToken,
            slug: parsed.slug,
            clientId: parsed.clientId,
            clientSecret: parsed.clientSecret,
            redirectDomains: parsed.redirectDomains,
        });
        return outputsFor(parsed);
    },
    delete: async (inputs) => {
        const parsed = parse(inputs);
        await api.deleteClient({ baseUrl: parsed.authentikUrl, token: parsed.bootstrapToken, slug: parsed.slug });
    },
});
