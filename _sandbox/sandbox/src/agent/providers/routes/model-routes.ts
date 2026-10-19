import type { AgentLoop, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { EndpointConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import {
    endpointIdOf,
    loopLabel,
    loopsOf,
    PROVIDER_ACCESS,
    PROVIDER_VENDOR,
    providerLabel,
    TRIAL_ENDPOINT_ID,
    TRIAL_MODEL_ID,
} from "@intentic/sandbox-contract/models/agent-catalog";
import { type MintedProvider, mintedVariant, providerSpec, type TranslatorProvider } from "@intentic/sandbox-contract/models/provider-specs";
import type { Model } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { Services } from "../../../composition.js";
import { opt } from "../../../opt.js";
import { parseHeaders, unversionedBase, versionedBase } from "../../../endpoints/endpoint-config.js";
import { endpointModelId } from "../../../endpoints/endpoint-translator.js";
import { endpointConfigOf } from "../../../endpoints/local-model.js";
import type { TurnAllowance } from "../harness-credentials.js";

// Where a model is reached, apart from which loop drives it. One answer per (provider, account, model, loop): the wire
// the loop speaks there, the URL and bearer it sends to, the model id that URL knows, whose account and allowance the
// turn spends, and which provider the privacy shield keys the route on. Every loop the daemon names a URL for plans its
// credential from this: the Claude Code harness (harness-credentials.ts), Codex (runtimes/codex) and OpenCode's hosted
// providers (runtimes/opencode/hosted/opencode-routes.ts). The two OpenCode pairs whose provider config OpenCode itself owns,
// Grok on its own xAI sign-in and Google through its fixed `intentic-gemini` entry, keep their own planners.

// What the loop speaks to the route's URL. Each loop reaches a provider only on a wire both ends speak: Claude Code
// speaks Anthropic Messages, Codex only OpenAI Responses, and OpenCode whichever SDK package the route names.
export type RouteWire = "anthropic-messages" | "openai-responses" | "openai-chat";

// The URL a route's requests go to, split where the privacy shield's gateway stands in: `base` is what the gateway
// forwards to (and what it replaces), `path` the version segment the wire's own paths hang off. Anthropic Messages has
// none here, since its clients append /v1/messages themselves; the OpenAI wires carry theirs (/v1, Z.ai's /v4).
export interface RouteEndpoint {
    readonly base: string;
    readonly path: string;
    readonly token: string;
    // Headers the owner declared on an endpoint card; absent for everything else.
    readonly headers?: Readonly<Record<string, string>>;
}

export interface ModelRoute {
    readonly provider: AgentProvider;
    readonly loop: AgentLoop;
    readonly wire: RouteWire;
    // Who serves the URL: the bundled translator (a subscription it holds), the vendor's own endpoint (a minted key), or
    // an endpoint the owner configured (their key).
    readonly via: "translator" | "vendor" | "endpoint";
    readonly endpoint: RouteEndpoint;
    // The id the URL knows the model by: the catalog's own, or the translator's `<endpoint>/<model>` for an endpoint it
    // re-serves.
    readonly model: string;
    // The catalog row behind `model`, where the route read one: its window and reasoning tiers, for a loop that has no
    // catalog of its own for this provider's models (Codex treats an unknown model as a 272k window with no tiers).
    readonly modelRow?: Model;
    // The stored account that answered, where the route picked one (a minted key); absent for the translator's pool.
    readonly account?: string;
    // What the turn's usage and rate-limit frames are stamped with, where anything is.
    readonly attribution?: string;
    // The provider the privacy shield's gateway session and trust are keyed on.
    readonly shield: string;
    // Whose allowance the turn spends, and what is left of it where that is readable.
    readonly allowance?: TurnAllowance;
    // The platform's free trial, which runs on its own bounded retry policy.
    readonly trial?: true;
}

// A route the loop can't take, in the words the turn is refused with; the same shape a harness refusal has.
export interface RouteRefusal {
    readonly ok: false;
    readonly code?: "subscription-required" | "trial-unavailable";
    readonly message: string;
}

export type RouteResult = { readonly ok: true; readonly route: ModelRoute } | RouteRefusal;

// What a route is resolved from: the stores behind each credential kind, and the catalogs a pick is validated against.
export type RouteDeps = Pick<
    Services,
    "capabilities" | "cliProxy" | "config" | "endpointModels" | "minted" | "providerCatalogs" | "trial" | "wakeLocalModel"
>;

export interface RouteInput {
    readonly provider: AgentProvider;
    readonly loop: AgentLoop;
    // The account the conversation runs on, where the provider keeps more than one; a named one that is gone refuses.
    readonly account?: string | undefined;
    readonly model?: string | undefined;
}

// The URL a loop sends to: the gateway in place of the base where the shield stands, the wire's version path after it.
export const routeUrl = (endpoint: Pick<RouteEndpoint, "base" | "path">, gateway?: string): string =>
    `${(gateway ?? endpoint.base).replace(/\/$/, "")}${endpoint.path}`;

// Validates a pick against the live catalog; falls to the catalog default if the pick isn't offered.
export const routedModel = (catalog: { models: readonly { id: string }[]; default: string }, model: string | undefined): string =>
    model !== undefined && model !== "" && catalog.models.some((entry) => entry.id === model) ? model : catalog.default;

const rowOf = (catalog: { models: readonly Model[] }, id: string): Model | undefined => catalog.models.find((entry) => entry.id === id);

// A versioned OpenAI root split where the gateway stands in: "https://api.z.ai/api/coding/paas/v4" is the base
// "https://api.z.ai/api/coding/paas" and the path "/v4".
const splitVersioned = (url: string): Pick<RouteEndpoint, "base" | "path"> => {
    const base = unversionedBase(url);
    return { base, path: versionedBase(url).slice(base.length) };
};

// What each loop speaks to a provider's route; OpenCode follows the provider, since its SDK packages speak each wire.
const wireOf = (loop: AgentLoop, provider: AgentProvider, endpointProtocol?: "openai" | "anthropic"): RouteWire | undefined => {
    switch (loop) {
        case "claude-code":
            return "anthropic-messages";
        case "codex":
            return "openai-responses";
        case "opencode":
            // A ChatGPT plan is served on the translator's Responses surface, Codex's own; everything else on OpenCode
            // speaks Chat Completions, but an Anthropic endpoint, which OpenCode's Anthropic package drives as it is.
            if (endpointProtocol !== undefined) {
                return endpointProtocol === "anthropic" ? "anthropic-messages" : "openai-chat";
            }
            return provider === "codex" ? "openai-responses" : "openai-chat";
        default:
            return undefined;
    }
};

const onLoop = (provider: AgentProvider, loop: AgentLoop): string => `${providerLabel(provider)} on ${loopLabel(provider, loop)}`;

const NO_ROUTE = (provider: AgentProvider, loop: AgentLoop): RouteRefusal => ({
    ok: false,
    message: `${providerLabel(provider)} doesn't run on ${loopLabel(provider, loop)} here.`,
});

// The translator's endpoint for a provider it holds a subscription for, or why there isn't one. Split from the model, so
// a loop with its own catalog for its own provider (Codex on ChatGPT) takes the credential and resolves the model itself.
export const translatorEndpoint = async (
    services: Pick<Services, "cliProxy" | "config">,
    provider: TranslatorProvider,
    loop: AgentLoop,
): Promise<{ readonly ok: true; readonly endpoint: RouteEndpoint } | RouteRefusal> => {
    if (services.config.translator.url === "") {
        if (loop === "claude-code") {
            // Codex/Grok fall back to their own loop; Kimi has none, so this is only an image problem for it.
            const fallback =
                provider === "kimi"
                    ? "Run a sandbox built from the published image."
                    : "Use the provider's native harness, or run a sandbox built from the published image.";
            return {
                ok: false,
                message: `This sandbox has no model translator, so a non-Claude model can't run under the Claude Code harness here. ${fallback}`,
            };
        }
        return {
            ok: false,
            message: `This sandbox has no model translator, so ${onLoop(provider, loop)} can't run here. Run a sandbox built from the published image.`,
        };
    }
    if ((await services.cliProxy.accounts())[provider].length === 0) {
        return {
            ok: false,
            code: "subscription-required",
            message:
                loop === "claude-code"
                    ? `Connect your ${PROVIDER_ACCESS[provider].requirement} in Sandbox ▸ Agent to run ${provider} under the Claude Code harness.`
                    : `Connect your ${PROVIDER_ACCESS[provider].requirement} in Sandbox ▸ Agent to run ${onLoop(provider, loop)}.`,
        };
    }
    // Claude Code appends /v1/messages to the root itself; the OpenAI clients take the versioned root.
    return {
        ok: true,
        endpoint: { base: services.config.translator.url, path: loop === "claude-code" ? "" : "/v1", token: services.config.translator.token },
    };
};

const resolveTranslatorRoute = async (services: RouteDeps, provider: TranslatorProvider, loop: AgentLoop, wire: RouteWire, pick: string | undefined): Promise<RouteResult> => {
    const reached = await translatorEndpoint(services, provider, loop);
    if (!reached.ok) {
        return reached;
    }
    // Validated against the provider's own live catalog, the same table the native paths and the picker read.
    const catalog = await services.providerCatalogs[provider].models();
    // Named once and shared: the endpoint sends it upstream and the allowance reads the pool it spends.
    const model = routedModel(catalog, pick);
    const row = rowOf(catalog, model);
    return {
        ok: true,
        route: {
            provider,
            loop,
            wire,
            via: "translator",
            endpoint: reached.endpoint,
            model,
            ...opt("modelRow", row),
            shield: provider,
            allowance: { vendor: PROVIDER_VENDOR[provider], limit: () => services.cliProxy.turnLimit(provider, model) },
        },
    };
};

// The refusal for a conversation whose own account is no longer connected: which way on is the person's to choose.
export const goneAccountMessage = (provider: string): string =>
    `The ${provider} account this conversation runs on is no longer connected. Pick another account for it, or connect this one again, then send again.`;

// A minted provider publishes its own endpoints, so the loop is pointed at the estate's with the sign-in's key; no
// translation. Which of them depends on the wire: Anthropic Messages, Responses, or Chat Completions (the catalog root).
const resolveMintedRoute = async (
    services: Pick<Services, "minted">,
    provider: MintedProvider,
    loop: AgentLoop,
    wire: RouteWire,
    input: Pick<RouteInput, "account" | "model">,
): Promise<RouteResult> => {
    const accounts = await services.minted[provider].store.credentials();
    // The account the conversation runs on; only a turn naming none takes the first. A named one that is gone refuses:
    // running on another account instead is a switch nobody chose.
    const picked = input.account === undefined ? accounts[0] : accounts.find((account) => account.id === input.account);
    if (picked === undefined && input.account !== undefined) {
        return { ok: false, message: goneAccountMessage(providerLabel(provider)) };
    }
    if (picked === undefined) {
        return {
            ok: false,
            code: "subscription-required",
            message: `Connect your ${PROVIDER_ACCESS[provider].requirement} in Sandbox ▸ Agent to run ${providerLabel(provider)}.`,
        };
    }
    // An estate the provider no longer has is refused, not defaulted to a host the key was never minted for.
    const variant = mintedVariant(provider, picked.variant);
    if (variant === undefined) {
        return {
            ok: false,
            code: "subscription-required",
            message: `That ${providerLabel(provider)} account was connected through a sign-in this sandbox no longer offers. Connect it again in Sandbox ▸ Agent.`,
        };
    }
    const reach =
        wire === "anthropic-messages"
            ? { base: unversionedBase(variant.anthropicBase), path: "" }
            : wire === "openai-chat"
              ? splitVersioned(variant.catalogBase)
              : variant.responsesBase === undefined
                ? undefined
                : splitVersioned(variant.responsesBase);
    if (reach === undefined) {
        return { ok: false, message: `${variant.label} publishes no endpoint ${loopLabel(provider, loop)} can speak to, so ${onLoop(provider, loop)} can't run.` };
    }
    // Validated against the estate's live catalog; a retired pick falls to the catalog default, never empty.
    const catalog = await services.minted[provider].catalogOf(variant.id).models();
    const model = routedModel(catalog, input.model);
    const row = rowOf(catalog, model);
    return {
        ok: true,
        route: {
            provider,
            loop,
            wire,
            via: "vendor",
            endpoint: { ...reach, token: picked.apiKey },
            model,
            ...opt("modelRow", row),
            account: picked.id,
            attribution: picked.id,
            shield: provider,
            // No `limit`: no vendor here publishes a quota surface a minted key can read.
            allowance: { vendor: PROVIDER_VENDOR[provider] },
        },
    };
};

// Resolves from constants, not discovery: the trial's model id and route are fixed. Gates on the platform's cached
// trial-offered capability, re-probing once if the cache is cold.
const resolveTrialRoute = async (services: Pick<Services, "capabilities" | "config" | "trial">, provider: AgentProvider, loop: AgentLoop): Promise<RouteResult> => {
    if ((await services.capabilities.get(TRIAL_ENDPOINT_ID)) === undefined) {
        await services.trial.refresh();
    }
    const capability = await services.capabilities.get(TRIAL_ENDPOINT_ID);
    if (capability === undefined || capability.kind !== "endpoint") {
        return {
            ok: false,
            code: "trial-unavailable",
            message: "The free trial is no longer available from this sandbox. Connect a model in Sandbox ▸ Agent to keep going.",
        };
    }
    if (services.config.translator.url === "") {
        return {
            ok: false,
            code: "trial-unavailable",
            message:
                "The free trial needs the sandbox's bundled model translator. Rebuild this sandbox from the published image, or connect a model in Sandbox ▸ Agent.",
        };
    }
    return {
        ok: true,
        route: {
            provider,
            loop,
            wire: "anthropic-messages",
            via: "translator",
            endpoint: { base: services.config.translator.url, path: "", token: services.config.translator.token },
            model: endpointModelId(TRIAL_ENDPOINT_ID, TRIAL_MODEL_ID),
            shield: provider,
            trial: true,
        },
    };
};

// Idle-unload may have stopped this server, and the model catalog asks the server itself, so it has to be up before
// that question is worth asking. A wake that fails changes nothing: the empty catalog then reports it as not serving.
// Through Services rather than by calling the handler, which would pull agent/providers into the capability graph.
const wakeIfLocalModel = async (services: Pick<Services, "wakeLocalModel">, kind: string, id: string): Promise<void> => {
    if (kind !== "localmodel") {
        return;
    }
    await services.wakeLocalModel(id);
};

// How a loop reaches an endpoint the owner configured: in its own protocol where the loop speaks it, else through the
// translator's entry for it (endpoint-translator.ts), which re-serves an OpenAI-compatible endpoint on Anthropic
// Messages and Responses and keeps the owner's key out of the loop's environment.
const endpointReach = (
    services: Pick<Services, "config">,
    provider: AgentProvider,
    id: string,
    loop: AgentLoop,
    config: EndpointConfig,
    resolved: string,
): Pick<ModelRoute, "wire" | "via" | "endpoint" | "model"> | RouteRefusal => {
    const token = config.apiKey ?? "";
    // OpenCode drives either protocol straight at the endpoint, its own key and headers included.
    if (loop === "opencode") {
        const headers = parseHeaders(config.headers);
        const declared = Object.keys(headers).length === 0 ? undefined : headers;
        const anthropic = config.protocol === "anthropic";
        const reach = anthropic ? { base: unversionedBase(config.baseUrl), path: "/v1" } : splitVersioned(config.baseUrl);
        return {
            wire: anthropic ? "anthropic-messages" : "openai-chat",
            via: "endpoint",
            endpoint: { ...reach, token, ...opt("headers", declared) },
            model: resolved,
        };
    }
    if (config.protocol === "anthropic") {
        return { wire: "anthropic-messages", via: "endpoint", endpoint: { base: unversionedBase(config.baseUrl), path: "", token }, model: resolved };
    }
    if (services.config.translator.url === "") {
        const message =
            loop === "claude-code"
                ? "This sandbox has no model translator, so an OpenAI-compatible endpoint can't run here. Run a sandbox built from the published image."
                : `This sandbox has no model translator, so ${id} can't run on ${loopLabel(provider, loop)} here. Run it on OpenCode, or a sandbox built from the published image.`;
        return { ok: false, message };
    }
    return {
        wire: loop === "claude-code" ? "anthropic-messages" : "openai-responses",
        via: "translator",
        endpoint: { base: services.config.translator.url, path: loop === "claude-code" ? "" : "/v1", token: services.config.translator.token },
        model: endpointModelId(id, resolved),
    };
};

// Nothing published usually means weights are still downloading or loading, not misconfigured.
const notServing = (id: string, kind: string, config: EndpointConfig): RouteRefusal => ({
    ok: false,
    message:
        kind === "localmodel"
            ? `${id} isn't serving yet, its model may still be downloading or loading. Check its capability card.`
            : `${id} has published no models, check the server is running at ${config.baseUrl} and has a model loaded.`,
});

const resolveEndpointRoute = async (services: RouteDeps, provider: AgentProvider, id: string, loop: AgentLoop, pick: string | undefined): Promise<RouteResult> => {
    if (id === TRIAL_ENDPOINT_ID) {
        return loop === "claude-code" ? resolveTrialRoute(services, provider, loop) : NO_ROUTE(provider, loop);
    }
    const capability = await services.capabilities.get(id);
    // A localmodel capability resolves here too, as its loopback endpoint; id is `endpoint/<id>` either way.
    const config = capability === undefined ? undefined : endpointConfigOf(capability);
    if (capability === undefined || config === undefined) {
        return { ok: false, message: `Unknown model endpoint "${id}", add it as an Endpoint capability first.` };
    }
    // Before the catalog read: no read can make an Anthropic endpoint speak Responses.
    if (loop === "codex" && config.protocol === "anthropic") {
        return {
            ok: false,
            message: `Codex speaks only OpenAI's Responses API, and ${id} speaks Anthropic's, which nothing here translates for it. Run ${id} on Claude Code or OpenCode instead.`,
        };
    }
    await wakeIfLocalModel(services, capability.kind, id);
    const catalog = await services.endpointModels.models(id, config);
    if (catalog.models.length === 0) {
        return notServing(id, capability.kind, config);
    }
    const resolved = routedModel(catalog, pick);
    const reach = endpointReach(services, provider, id, loop, config, resolved);
    if ("ok" in reach) {
        return reach;
    }
    return { ok: true, route: { provider, loop, shield: provider, ...reach, ...opt("modelRow", rowOf(catalog, resolved)) } };
};

// The one resolver: (provider, account, model, loop) to the route that loop takes. Refuses a pair the provider does not
// offer, and the two OpenCode pairs whose provider config OpenCode owns (Grok, Google), which no URL here describes.
export const resolveRoute = async (services: RouteDeps, input: RouteInput): Promise<RouteResult> => {
    const { provider, loop } = input;
    const endpointId = endpointIdOf(provider);
    if (endpointId !== undefined) {
        if (!loopsOf(provider).includes(loop)) {
            return NO_ROUTE(provider, loop);
        }
        return resolveEndpointRoute(services, provider, endpointId, loop, input.model);
    }
    const spec = providerSpec(provider);
    const wire = wireOf(loop, provider);
    if (spec === undefined || wire === undefined || !loopsOf(spec.id).includes(loop)) {
        return NO_ROUTE(provider, loop);
    }
    if (spec.auth.kind === "minted") {
        // SAFETY: a row whose auth is minted is a MintedProvider; the union is derived from exactly that kind.
        return resolveMintedRoute(services, spec.id as MintedProvider, loop, wire, input);
    }
    // Google and Grok on OpenCode are OpenCode's own provider entries, planned by their own runtimes.
    const ownEntry = loop === "opencode" && (spec.id === "grok" || spec.id === "gemini");
    if (spec.auth.kind === "translator" && !ownEntry) {
        // SAFETY: a row whose auth is translator is a TranslatorProvider; the union is derived from exactly that kind.
        return resolveTranslatorRoute(services, spec.id as TranslatorProvider, loop, wire, input.model);
    }
    return NO_ROUTE(provider, loop);
};

// A provider id as a key other config formats can hold (a TOML dotted path, an OpenCode provider id): `endpoint/ollama`
// becomes `endpoint-ollama`. Distinct providers stay distinct, since an endpoint id is already a slug.
export const routeSlug = (provider: AgentProvider): string => provider.replaceAll(/[^A-Za-z0-9_-]+/g, "-");

// Whether a pair could take a route now, from cheap facts only (a sign-in on file, a card configured, a translator to
// serve it), for the runtime health sweep; the turn's own resolve still reads the catalog and may refuse past this.
export type RouteReadiness = { readonly ready: true } | { readonly ready: false; readonly detail: string };

const readinessOf = (result: RouteRefusal | undefined): RouteReadiness => (result === undefined ? { ready: true } : { ready: false, detail: result.message });

const endpointReadiness = async (services: Pick<Services, "capabilities" | "config">, provider: AgentProvider, id: string, loop: AgentLoop): Promise<RouteReadiness> => {
    const capability = await services.capabilities.get(id);
    const config = capability === undefined ? undefined : endpointConfigOf(capability);
    if (config === undefined) {
        return { ready: false, detail: `Unknown model endpoint "${id}", add it as an Endpoint capability first.` };
    }
    if (loop === "codex" && config.protocol === "anthropic") {
        return { ready: false, detail: `Codex speaks only OpenAI's Responses API, and ${id} speaks Anthropic's. Run it on Claude Code or OpenCode instead.` };
    }
    const reach = endpointReach(services, provider, id, loop, config, "");
    return "ok" in reach ? readinessOf(reach) : { ready: true };
};

const mintedReadiness = async (services: Pick<Services, "minted">, provider: MintedProvider, loop: AgentLoop): Promise<RouteReadiness> => {
    const accounts = await services.minted[provider].store.credentials();
    if (accounts.length === 0) {
        return { ready: false, detail: `Connect your ${PROVIDER_ACCESS[provider].requirement} in Sandbox ▸ Agent to run ${onLoop(provider, loop)}.` };
    }
    // Codex needs the estate's Responses root; an estate without one cannot serve it, however many keys it holds.
    const served = accounts.some((account) => {
        const variant = mintedVariant(provider, account.variant);
        return variant !== undefined && (loop !== "codex" || variant.responsesBase !== undefined);
    });
    return served ? { ready: true } : { ready: false, detail: `No connected ${providerLabel(provider)} account's estate publishes an endpoint ${loopLabel(provider, loop)} can speak to.` };
};

export const routeReadiness = async (
    services: Pick<Services, "capabilities" | "cliProxy" | "config" | "minted">,
    provider: AgentProvider,
    loop: AgentLoop,
): Promise<RouteReadiness> => {
    if (!loopsOf(provider).includes(loop)) {
        return readinessOf(NO_ROUTE(provider, loop));
    }
    const endpointId = endpointIdOf(provider);
    if (endpointId !== undefined) {
        return endpointReadiness(services, provider, endpointId, loop);
    }
    const spec = providerSpec(provider);
    if (spec?.auth.kind === "minted") {
        // SAFETY: a row whose auth is minted is a MintedProvider; the union is derived from exactly that kind.
        return mintedReadiness(services, spec.id as MintedProvider, loop);
    }
    if (spec?.auth.kind === "translator") {
        // SAFETY: a row whose auth is translator is a TranslatorProvider; the union is derived from exactly that kind.
        const reached = await translatorEndpoint(services, spec.id as TranslatorProvider, loop);
        return readinessOf(reached.ok ? undefined : reached);
    }
    return readinessOf(NO_ROUTE(provider, loop));
};
