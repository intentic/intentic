import type { EndpointConfig } from "@intentic/sandbox-contract";

/* READING AN ENDPOINT'S CONFIG, the pure half, shared by the three things that consume one: the model catalog
 * (which asks the server what it serves), the translator reconciler (which hands it to CLIProxyAPI), and the
 * turn's credential resolution (which points the harness at it). One module because a URL that means one thing
 * to the catalog and another to the turn is a bug that only shows up as a 404 mid-conversation. */

/* THE VERSION SEGMENT, which the two ecosystems put on opposite sides of the line the user is asked to write.
 *
 * OpenAI-compatible servers document their base WITH it (`http://localhost:11434/v1`, `https://openrouter.ai/api/v1`)
 * and append `/chat/completions`. Anthropic's own clients. Claude Code included, document ANTHROPIC_BASE_URL
 * WITHOUT it and append `/v1/messages` themselves. Both conventions are correct in their own world, and a user
 * pasting the URL their server's README gave them is right either way.
 *
 * So neither form is demanded: the segment is stripped or added per consumer, and pasting `…:11434`,
 * `…:11434/v1` or `…:11434/v1/` all reach the same place. This is the entire reason the field takes free text
 * rather than two protocol-conditional inputs the user would have to know to tell apart. */
const VERSION_SUFFIX = /\/v\d+$/;
const trimmed = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, "");

// The API root WITH its version segment, what an OpenAI-compatible client (and CLIProxyAPI's `base-url`) wants.
export const versionedBase = (baseUrl: string): string => {
    const base = trimmed(baseUrl);
    return VERSION_SUFFIX.test(base) ? base : `${base}/v1`;
};

// The API root WITHOUT it, what ANTHROPIC_BASE_URL wants, since the harness appends `/v1/messages` itself.
export const unversionedBase = (baseUrl: string): string => trimmed(baseUrl).replace(VERSION_SUFFIX, "");

/* The pasted `Name: value` block, one per line. Blank lines and `#` comments are skipped so a user can annotate
 * the block; a line with no colon is skipped rather than rejected, because the alternative is a capability that
 * refuses to save over a stray word while the header that matters is sitting right above it. Values keep their
 * own colons (a URL header), so only the FIRST colon splits. */
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

/* What authenticates a direct call to the endpoint, the catalog read, and (for an anthropic-protocol endpoint)
 * every turn. Each protocol's own scheme, because a server that speaks one and is handed the other's header
 * answers 401 with nothing to point at: OpenAI-compatible servers read `Authorization: Bearer`, Anthropic ones
 * read `x-api-key` alongside a required `anthropic-version`.
 *
 * A missing key is an ordinary configuration, not an omission to warn about: a model server on the docker host
 * usually has no auth at all, and Ollama in particular ignores whatever is sent. So the header is simply absent
 * and the request goes out unauthenticated. */
const endpointAuthHeaders = (config: EndpointConfig): Record<string, string> => {
    const key = config.apiKey ?? "";
    if (config.protocol === "anthropic") {
        return { "anthropic-version": "2023-06-01", ...(key === "" ? {} : { "x-api-key": key }) };
    }
    return key === "" ? {} : { authorization: `Bearer ${key}` };
};

// Everything a direct request to this endpoint carries: its protocol's auth, then the user's own header block,
// last so a gateway that wants a non-standard auth header can override ours rather than fight it.
export const endpointHeaders = (config: EndpointConfig): Record<string, string> => ({
    ...endpointAuthHeaders(config),
    ...parseHeaders(config.headers),
});
