import { BrowsingModelSchema, type BrowsingCatalogSnapshot } from "@intentic/api-contract/ingress";
import { NATIVE_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import { humanizeModelId } from "@intentic/sandbox-contract/models/model-label";
import { compareUnrankedModelIds } from "@intentic/sandbox-contract/models/model-order";
import { z } from "zod";

// Each source is chosen for an integration, not a vendor: an API catalog is not proof of subscription access.
// Headers belong to the platform's service accounts and never travel in a snapshot, error body or log.
export const CatalogSourceSchema = z.object({
    provider: z.enum(NATIVE_PROVIDERS),
    url: z.url().refine((url) => new URL(url).protocol === `https:`, `catalog sources require HTTPS`),
    format: z.enum([`anthropic`, `openai`, `catalog`]),
    headers: z.record(z.string(), z.string()).default({}),
    // A stable integration filter, such as ^claude- or ^gpt-; required for broad API catalogs containing non-chat models.
    include: z.string().min(1),
});
export type CatalogSource = z.infer<typeof CatalogSourceSchema>;
const SourceListSchema = z.array(CatalogSourceSchema).refine((sources) => new Set(sources.map((source) => source.provider)).size === sources.length,
    `only one catalog source per integration`);

export const catalogSources = (raw: string): CatalogSource[] => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // JSON parser errors can echo configuration fragments containing service credentials.
        throw new Error(`MODEL_CATALOG_SOURCES must contain valid JSON`);
    }
    const sources = SourceListSchema.parse(parsed);
    // Reject a broken filter at startup, rather than silently expiring that integration's catalog a week later.
    for (const source of sources) {
        source.include = new RegExp(source.include, `u`).source;
    }
    return sources;
};

const ApiPageSchema = z.object({
    data: z.array(z.object({ id: z.string().min(1), display_name: z.string().optional() })),
    has_more: z.boolean().optional(),
    last_id: z.string().optional(),
});
const PublishedSchema = z.object({ models: z.array(BrowsingModelSchema).min(1) });

type CatalogFetch = (url: URL, init: RequestInit) => Promise<Response>;
type DiscoveredModels = BrowsingCatalogSnapshot["models"];

const readCatalogPage = async (source: CatalogSource, url: URL, signal: AbortSignal, fetcher: CatalogFetch): Promise<{ models: DiscoveredModels; cursor?: string }> => {
    const response = await fetcher(url, { headers: source.headers, signal, redirect: `error` });
    if (!response.ok) {
        throw new Error(`catalog upstream returned ${response.status}`);
    }
    const raw: unknown = await response.json();
    if (source.format === `catalog`) {
        return { models: PublishedSchema.parse(raw).models };
    }
    const parsed = ApiPageSchema.parse(raw);
    if (parsed.has_more === true && parsed.last_id === undefined) {
        throw new Error(`catalog upstream did not advance pagination`);
    }
    return {
        models: parsed.data.map((row) => ({ id: row.id, label: row.display_name || humanizeModelId(row.id) })),
        cursor: parsed.has_more === true ? parsed.last_id : undefined,
    };
};

const completeDiscovery = (source: CatalogSource, models: Map<string, DiscoveredModels[number]>): DiscoveredModels => {
    if (models.size === 0) {
        throw new Error(`catalog upstream returned no matching models`);
    }
    const result = [...models.values()];
    return source.format === `openai` ? result.sort((a, b) => compareUnrankedModelIds(a.id, b.id)) : result;
};

export const discoverBrowsingModels = async (source: CatalogSource, fetcher: CatalogFetch = fetch): Promise<BrowsingCatalogSnapshot["models"]> => {
    const include = new RegExp(source.include, `u`);
    const models = new Map<string, { id: string; label: string }>();
    let url = new URL(source.url);
    const cursors = new Set<string>();
    // One deadline for the entire paginated read; a partial list is never adopted as a successful refresh.
    const signal = AbortSignal.timeout(20_000);
    for (let page = 0; page < 100; page++) {
        const { models: rows, cursor } = await readCatalogPage(source, url, signal, fetcher);
        for (const row of rows) {
            if (include.test(row.id)) {
                models.set(row.id, row);
            }
        }
        if (cursor === undefined) {
            return completeDiscovery(source, models);
        }
        if (cursors.has(cursor)) {
            throw new Error(`catalog upstream did not advance pagination`);
        }
        cursors.add(cursor);
        url = new URL(source.url);
        url.searchParams.set(source.format === `anthropic` ? `after_id` : `after`, cursor);
    }
    throw new Error(`catalog upstream exceeded pagination limit`);
};
