// Shared helpers for the OpenAI-compatible `/v1/models` shape four of the five providers use: a bearer header, a GET
// that returns undefined instead of throwing, and the `{ data: [{ id }] }` unwrap. Per-provider concerns (which ids are
// chat models, which endpoints in what order) stay with the provider; an unnamed id reads through the contract's
// humanizeModelId, the rule the app's labels share.
import { compareUnrankedModelIds, humanizeModelId } from "@intentic/sandbox-contract";

// Bare ids → the wire shape, for providers whose discovery returns nothing but ids. Neither publishes a ranking, so the
// app orders them (compareUnrankedModelIds) and takes the head as `default`; callers with richer data order their own.
export const idCatalog = (ids: readonly string[]): { models: { id: string; label: string }[]; default: string } => {
    const ordered = ids.toSorted(compareUnrankedModelIds);
    return { models: ordered.map((id) => ({ id, label: humanizeModelId(id) })), default: ordered[0]! };
};

export const authHeader = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

// GETs a JSON endpoint, returning undefined for every way it can fail (unreachable, non-2xx, not JSON) rather than
// throwing, so a ladder rung that can't answer lets the caller fall to the next one.
export const getJson = async <T>(url: string, token: string, fetchImpl: typeof fetch): Promise<T | undefined> => {
    const response = await fetchImpl(url, { headers: authHeader(token) }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        return undefined;
    }
    return (await response.json().catch(() => undefined)) as T | undefined;
};

// One row of an OpenAI-compatible model list. `owner` (`owned_by`) is the only field separating vendors when a
// multiplexing translator serves several subscriptions on one endpoint.
export interface ListedModel {
    readonly id: string;
    readonly owner?: string;
}

// Unwraps an OpenAI-compatible model list; `data` is the standard key, xAI's native endpoint says `models` instead,
// handled here rather than in a second helper. [] on any failure.
export const listModels = async (url: string, token: string, fetchImpl: typeof fetch): Promise<readonly ListedModel[]> => {
    const json = await getJson<{ data?: { id: string; owned_by?: string }[]; models?: { id: string; owned_by?: string }[] }>(url, token, fetchImpl);
    return (json?.data ?? json?.models ?? []).map((model) => ({ id: model.id, ...(model.owned_by === undefined ? {} : { owner: model.owned_by }) }));
};

// Ids a vendor names in "Model not found … Did you mean: a, b, c?": the only catalog available when a token can't
// enumerate the REST endpoint. Only text after "did you mean" is scanned, so the rejected id itself is never mistaken
// for a valid one.
export const suggestedModels = (message: string, pattern: RegExp): string[] => {
    const hint = message.split(/did you mean:?/i)[1];
    if (hint === undefined) {
        return [];
    }
    return [...new Set(hint.match(pattern) ?? [])];
};
