import { createHash } from "node:crypto";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { endpointIdOf, endpointProvider, PROVIDER_VENDOR, providerLabel, TRIAL_ENDPOINT_ID } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Model } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { NATIVE_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import { endpointConfigOf, mintsEndpointProvider } from "../../../endpoints/local-model.js";
import { opt } from "../../../opt.js";
import { type ModelRoute, resolveRoute, type RouteDeps, routeSlug, routeUrl, type RouteWire } from "../../../agent/providers/routes/model-routes.js";
import type { OpenCodeConfig } from "../opencode-config.js";

// The providers OpenCode hosts from a route (agent/providers/routes/model-routes.ts): every route the loop could take
// now, one OpenCode provider entry each, written into the shared server's config at spawn beside xAI and Google. A
// ChatGPT plan and Kimi through the translator, each Z.ai account on its own estate's Chat Completions root with its
// minted key, and each endpoint the owner configured, straight at it in its own protocol. OpenCode fixes its providers
// at spawn, so the service compares this set at each hosted turn's acquisition and restarts an idle server when it
// changed (opencode.ts).

// One hosted provider as the server is told about it. `base` is what the privacy shield's gateway stands in for.
export interface OpenCodeRouteEntry {
    // The OpenCode provider id a turn names: `intentic-<provider>`, and the account after it where the provider keeps
    // several keys of its own (each its own entry, since each is its own key).
    readonly id: string;
    readonly provider: AgentProvider;
    // What a failure sentence calls the backend.
    readonly label: string;
    readonly wire: RouteWire;
    readonly base: string;
    readonly path: string;
    readonly token: string;
    readonly headers?: Readonly<Record<string, string>>;
    // The provider the gateway session and trust are keyed on.
    readonly shield: string;
    readonly models: readonly OpenCodeRouteModel[];
}

export interface OpenCodeRouteModel {
    readonly id: string;
    readonly efforts?: readonly string[];
    readonly contextWindow?: number;
}

// Every hosted provider's id starts so, which is how the service tells a hosted acquisition from xAI's or Google's.
// Google's own `intentic-gemini` predates it and is not one: no provider named `gemini` is ever hosted.
export const ROUTE_ID_PREFIX = "intentic-route-";

// A route's OpenCode provider id: one per provider, or per (provider, account) where the route picked a stored key.
export const openCodeRouteId = (provider: AgentProvider, account?: string): string =>
    `${ROUTE_ID_PREFIX}${routeSlug(provider)}${account === undefined ? "" : `--${routeSlug(account)}`}`;

// What a failure sentence calls a hosted backend, read back off its id: the vendor whose allowance it spends, or the
// endpoint's own id. Undefined for an id no route makes.
export const routeLabelOf = (providerID: string): string | undefined => {
    if (!providerID.startsWith(ROUTE_ID_PREFIX)) {
        return undefined;
    }
    const slug = providerID.slice(ROUTE_ID_PREFIX.length).split("--")[0] ?? "";
    if (slug.startsWith("endpoint-")) {
        return slug.slice("endpoint-".length);
    }
    const provider = NATIVE_PROVIDERS.find((native) => native === slug);
    return provider === undefined ? undefined : PROVIDER_VENDOR[provider];
};

// Which AI SDK package speaks each wire, as OpenCode 2.0.26 bundles them (the `aisdk:` prefix names a bundled one).
const PACKAGE = {
    "openai-responses": "aisdk:@ai-sdk/openai",
    "openai-chat": "aisdk:@ai-sdk/openai-compatible",
    "anthropic-messages": "aisdk:@ai-sdk/anthropic",
} as const satisfies Record<RouteWire, string>;

// How long a hosted request may go without its response's headers, and its stream without a chunk, before OpenCode
// retries it: under the turn's two-minute silence limit, well over a thinking model's pause, as for Google.
const ROUTE_HEADER_TIMEOUT_MS = 100_000;
const ROUTE_CHUNK_TIMEOUT_MS = 100_000;

type ProviderConfigs = NonNullable<OpenCodeConfig["providers"]>;
type ModelConfig = NonNullable<ProviderConfigs[string]["models"]>[string];

// One variant per reasoning tier the catalog names, set the way each package takes it: the Responses package as its own
// `reasoningEffort` option, Chat Completions as the request's `reasoning_effort`. Anthropic's thinking takes a budget,
// not a tier, so a model there offers none rather than one OpenCode would send wrong.
const variantsOf = (wire: RouteWire, efforts: readonly string[] | undefined): ModelConfig["variants"] => {
    if (efforts === undefined || efforts.length === 0 || wire === "anthropic-messages") {
        return undefined;
    }
    return efforts.map((tier) => (wire === "openai-responses" ? { id: tier, settings: { reasoningEffort: tier } } : { id: tier, body: { reasoning_effort: tier } }));
};

// What a model is declared as. OpenCode has no catalog row for any of these, so a capability left out reads as absent:
// tools said outright, and pictures only where every model on the route takes them (a ChatGPT plan's), since a picture
// declared for a model that refuses one fails the turn while one left out is only named in the prompt.
const modelConfig = (entry: OpenCodeRouteEntry, model: OpenCodeRouteModel): ModelConfig => ({
    name: model.id,
    capabilities: { tools: true, input: entry.provider === "codex" ? ["text", "image"] : ["text"], output: ["text"] },
    ...opt("variants", variantsOf(entry.wire, model.efforts)),
    ...opt("limit", model.contextWindow === undefined ? undefined : { context: model.contextWindow }),
});

// The server's provider entries for every hosted route; `gateway` is the privacy shield's stand-in for an entry's base,
// absent while the shield is off.
export const routeProviderConfig = (entries: readonly (OpenCodeRouteEntry & { readonly gateway?: string })[]): ProviderConfigs =>
    Object.fromEntries(
        entries
            .filter((entry) => entry.models.length > 0)
            .map((entry) => [
                entry.id,
                {
                    name: entry.label,
                    package: PACKAGE[entry.wire],
                    settings: {
                        baseURL: routeUrl(entry, entry.gateway),
                        apiKey: entry.token,
                        headerTimeout: ROUTE_HEADER_TIMEOUT_MS,
                        chunkTimeout: ROUTE_CHUNK_TIMEOUT_MS,
                    },
                    ...opt("headers", entry.headers === undefined ? undefined : { ...entry.headers }),
                    models: Object.fromEntries(entry.models.map((model) => [model.id, modelConfig(entry, model)])),
                },
            ]),
    );

// What a server was booted with, compared at the next hosted acquisition: membership, where each entry sends, which key
// it holds (hashed, so a reconnected key restarts the server without the key sitting in memory twice), and each model's
// declared shape. Not the order discovery returned.
export const routeSignature = (entries: readonly OpenCodeRouteEntry[]): string =>
    JSON.stringify(
        [...entries]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((entry) => [
                entry.id,
                entry.wire,
                entry.base,
                entry.path,
                createHash("sha256").update(entry.token).digest("hex").slice(0, 16),
                entry.headers ?? {},
                [...entry.models].sort((a, b) => a.id.localeCompare(b.id)).map((model) => [model.id, [...(model.efforts ?? [])], model.contextWindow ?? 0]),
            ]),
    );

// Whether a provider id names a hosted route rather than OpenCode's own xAI or Google entries.
export const isOpenCodeRoute = (providerID: string, entries: readonly Pick<OpenCodeRouteEntry, "id">[]): boolean =>
    entries.some((entry) => entry.id === providerID);

// What the route resolver answers for one hosted pair, as the entry the server is told about, with its catalog's rows.
const entryOf = (route: ModelRoute, models: readonly Model[]): OpenCodeRouteEntry => ({
    id: openCodeRouteId(route.provider, route.account),
    provider: route.provider,
    label: providerLabel(route.provider),
    wire: route.wire,
    base: route.endpoint.base,
    path: route.endpoint.path,
    token: route.endpoint.token,
    ...opt("headers", route.endpoint.headers),
    shield: route.shield,
    // The translator re-serves an endpoint under `<id>/<model>`; straight at it, the id is the endpoint's own.
    models: models.map((model) => ({
        id: model.id,
        ...opt("efforts", model.efforts),
        ...opt("contextWindow", model.contextWindow),
    })),
});

// What enumerating the hosted routes reads: the resolver's stores, and the catalog each route's models come from.
export type OpenCodeRouteDeps = RouteDeps;

const catalogOf = async (services: OpenCodeRouteDeps, route: ModelRoute): Promise<readonly Model[]> => {
    const endpointId = endpointIdOf(route.provider);
    if (endpointId !== undefined) {
        const capability = await services.capabilities.get(endpointId);
        const config = capability === undefined ? undefined : endpointConfigOf(capability);
        return config === undefined ? [] : (await services.endpointModels.models(endpointId, config)).models;
    }
    if (route.provider === "zai") {
        // The estate's own catalog, the one the route validated its model against.
        const accounts = await services.minted.zai.store.credentials();
        const variant = accounts.find((account) => account.id === route.account)?.variant;
        return variant === undefined ? [] : (await services.minted.zai.catalogOf(variant).models()).models;
    }
    return route.provider === "codex" || route.provider === "kimi" ? (await services.providerCatalogs[route.provider].models()).models : [];
};

// Every (provider, account) OpenCode could host now: the translator's ChatGPT and Kimi pools, each connected Z.ai key,
// and each configured endpoint (the trial excluded, which runs on Claude Code alone).
const candidates = async (services: OpenCodeRouteDeps): Promise<{ readonly provider: AgentProvider; readonly account?: string }[]> => {
    const translator: { provider: AgentProvider }[] = [{ provider: "codex" }, { provider: "kimi" }];
    const zai = (await services.minted.zai.store.credentials()).map((account) => ({ provider: "zai" as const, account: account.id }));
    const cards = await services.capabilities.list();
    const endpoints = cards.filter((card) => mintsEndpointProvider(card.kind) && card.id !== TRIAL_ENDPOINT_ID).map((card) => ({ provider: endpointProvider(card.id) }));
    return [...translator, ...zai, ...endpoints];
};

// The hosted entries for every route that resolves now. A route that refuses (nobody signed in, a translator missing, an
// endpoint not serving) or whose catalog can't be read is left out: its turn is refused in the resolver's own words,
// and the server boots with the rest.
export const openCodeRouteEntries = async (services: OpenCodeRouteDeps): Promise<OpenCodeRouteEntry[]> => {
    const found = await Promise.all(
        (await candidates(services)).map(async ({ provider, account }) => {
            try {
                const resolved = await resolveRoute(services, { provider, loop: "opencode", account });
                if (!resolved.ok) {
                    return [];
                }
                const models = await catalogOf(services, resolved.route);
                return models.length === 0 ? [] : [entryOf(resolved.route, models)];
            } catch {
                // allow(silent-catch): a route that can't be read now is a provider the server boots without, not a failed boot
                return [];
            }
        }),
    );
    return found.flat();
};
