/* WHAT EVERY PROVIDER'S MODEL DISCOVERY DOES THE SAME WAY.
 *
 * Four of the five providers ask an OpenAI-compatible `/v1/models` (or the bundled translator's re-serving of
 * one) what this account can drive, and each had written the same four helpers beside its own filters: a
 * bearer header, a GET that answers `undefined` rather than throwing, the `{ data: [{ id }] }` unwrap, and a
 * label derived from the id. Three copies of the humanizer had already drifted, one uppercasing `gpt` and two
 * not, which is a difference a user sees in the picker.
 *
 * What is NOT here is the part that is genuinely per-provider: which ids count as chat models (each vendor
 * ships a different set of image/audio/embedding endpoints alongside them), and which endpoints to ask in
 * what order. Those stay next to the provider that knows them.
 */

// Ids whose case is the vendor's, not English's. Title-casing these reads as a typo in a picker row.
const ACRONYMS = new Set(["gpt", "oss", "api"]);

/* A raw model id → a display label: `gpt-5-codex` → "GPT 5 Codex", `grok-4-fast` → "Grok 4 Fast". Dotted and
 * dated segments pass through untouched (`grok-4.20-0309-reasoning` → "Grok 4.20 0309 Reasoning").
 *
 * Used only where the vendor publishes no name of its own. A provider that does publish one (Cursor, and the
 * translator's Gemini channel) uses it, because no rule over an id can recover "Gemini 3.1 Pro (High)" from
 * `gemini-pro-agent`, and inventing a plausible-looking name for a model that does not exist under it is
 * worse than showing the id.
 */
export const humanizeModelId = (id: string): string =>
    id
        .split("-")
        .map((token) => {
            if (token === "") {
                return token;
            }
            return ACRONYMS.has(token.toLowerCase()) ? token.toUpperCase() : token[0]!.toUpperCase() + token.slice(1);
        })
        .join(" ");

export const authHeader = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

// GET a JSON endpoint with a bearer token, answering `undefined` for every way it can fail to produce a body
// (unreachable, non-2xx, not JSON). Discovery is a ladder: a rung that cannot answer must let the caller fall
// to the next one, so nothing here throws.
export const getJson = async <T>(url: string, token: string, fetchImpl: typeof fetch): Promise<T | undefined> => {
    const response = await fetchImpl(url, { headers: authHeader(token) }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        return undefined;
    }
    return (await response.json().catch(() => undefined)) as T | undefined;
};

// One row of an OpenAI-compatible model list. `owner` is `owned_by`, which is the only field separating one
// vendor's models from another's when a multiplexing translator serves several subscriptions on one endpoint.
export interface ListedModel {
    readonly id: string;
    readonly owner?: string;
}

// An OpenAI-compatible model list, unwrapped. `data` is the standard key; xAI's native endpoint says `models`
// instead, and answering both here is cheaper than a second helper. [] on any failure.
export const listModels = async (url: string, token: string, fetchImpl: typeof fetch): Promise<readonly ListedModel[]> => {
    const json = await getJson<{ data?: { id: string; owned_by?: string }[]; models?: { id: string; owned_by?: string }[] }>(
        url,
        token,
        fetchImpl,
    );
    return (json?.data ?? json?.models ?? []).map((model) => ({ id: model.id, ...(model.owned_by === undefined ? {} : { owner: model.owned_by }) }));
};

/* The ids a vendor names when it rejects a model: "Model not found … Did you mean: a, b, c?". This is the
 * authoritative catalog for an account whose token cannot enumerate the REST endpoints, so it is worth
 * reading out of an error message.
 *
 * ONLY the part after "did you mean" is scanned, so the rejected id, which appears BEFORE it and is by
 * definition invalid, is never mistaken for a valid one. `pattern` is the caller's because the risk here is
 * over-matching the prose around the ids ("or", "instead"): a vendor whose ids all share a prefix should say
 * so rather than take every word in the clause.
 */
export const suggestedModels = (message: string, pattern: RegExp): string[] => {
    const hint = message.split(/did you mean:?/i)[1];
    if (hint === undefined) {
        return [];
    }
    return [...new Set(hint.match(pattern) ?? [])];
};
