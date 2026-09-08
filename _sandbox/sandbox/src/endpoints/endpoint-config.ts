import type { EndpointConfig } from "@intentic/sandbox-contract";

// Reading an endpoint's config, the pure half shared by the model catalog, the translator reconciler, and turn
// credential resolution; one module so a URL meaning one thing to one consumer and another to a second isn't a bug that
// surfaces mid-conversation.

// OpenAI bases include /v1, Anthropic's excludes it; the field takes free text so either pasted form works.
const VERSION_SUFFIX = /\/v\d+$/;
const trimmed = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, "");

// API root with its version segment, what an OpenAI-compatible client (and CLIProxyAPI's base-url) wants.
export const versionedBase = (baseUrl: string): string => {
    const base = trimmed(baseUrl);
    return VERSION_SUFFIX.test(base) ? base : `${base}/v1`;
};

// API root without it, what ANTHROPIC_BASE_URL wants, since the harness appends /v1/messages itself.
export const unversionedBase = (baseUrl: string): string => trimmed(baseUrl).replace(VERSION_SUFFIX, "");

// Pasted Name: value lines; blank/# lines and colon-less lines are skipped rather than rejected. Only the first colon
// splits, so a URL value keeps its own.
export const parseHeaders = (headers: string | undefined): Record<string, string> => {
    const parsed: Record<string, string> = {};
    for (const line of (headers ?? "").split("\n")) {
        const text = line.trim();
        if (text === "" || text.startsWith("#")) {
            continue;
        }
        const separator = text.indexOf(":");
        if (separator <= 0) {
            continue;
        }
        parsed[text.slice(0, separator).trim()] = text.slice(separator + 1).trim();
    }
    return parsed;
};

// Each protocol's own auth scheme (bearer vs x-api-key+version), since the wrong one 401s with nothing to point at. A
// missing key is ordinary, not a warning: it just goes out unauthenticated.
const endpointAuthHeaders = (config: EndpointConfig): Record<string, string> => {
    const key = config.apiKey ?? "";
    if (config.protocol === "anthropic") {
        return { "anthropic-version": "2023-06-01", ...(key === "" ? {} : { "x-api-key": key }) };
    }
    return key === "" ? {} : { authorization: `Bearer ${key}` };
};

// Protocol auth first, then the user's own header block, last so a gateway needing non-standard auth can override it.
export const endpointHeaders = (config: EndpointConfig): Record<string, string> => ({
    ...endpointAuthHeaders(config),
    ...parseHeaders(config.headers),
});
