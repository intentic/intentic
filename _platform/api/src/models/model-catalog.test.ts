import { BROWSING_CATALOG_MAX_AGE_MS, BROWSING_CATALOG_REFRESH_MS, type BrowsingCatalogSnapshot } from "@intentic/api-contract/ingress";
import { browseModels, refreshBrowsingCatalog, type BrowsingCatalogStore } from "./model-catalog.js";
import { catalogSources } from "./catalog-sources.js";
import { modelCatalogRoutes } from "./model-catalog.routes.js";

const sources = catalogSources(JSON.stringify([{ provider: `claude`, format: `anthropic`, url: `https://models.example/v1/models`, include: `^claude-` }]));
const model = (version: string) => ({ id: `claude-opus-${version}`, label: `Claude Opus ${version}` });
const memory = (initial: BrowsingCatalogSnapshot[] = []) => {
    let snapshots = initial;
    const store: BrowsingCatalogStore = {
        read: async () => snapshots,
        save: async (snapshot) => { snapshots = [...snapshots.filter((entry) => entry.provider !== snapshot.provider), snapshot]; },
    };
    return store;
};

test(`a new release replaces the browsing catalog without an application release, and fresh reads avoid upstream`, async () => {
    const at = BROWSING_CATALOG_REFRESH_MS * 10;
    const store = memory([{ provider: `claude`, verifiedAt: at, models: [model(`5`)] }]);
    const discover = jest.fn(async () => [model(`11`)]);
    const logger = { warn: jest.fn() };
    await refreshBrowsingCatalog(store, sources, logger, discover, () => at + BROWSING_CATALOG_REFRESH_MS - 1);
    expect(discover).toHaveBeenCalledTimes(0);
    await refreshBrowsingCatalog(store, sources, logger, discover, () => at + BROWSING_CATALOG_REFRESH_MS);
    expect(await browseModels(store, sources, at + BROWSING_CATALOG_REFRESH_MS)).toEqual({
        catalogs: [{ provider: `claude`, verifiedAt: at + BROWSING_CATALOG_REFRESH_MS, models: [model(`11`)] }],
    });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(0);
});

test(`an outage keeps the previous verification time and the public list expires at the freshness boundary`, async () => {
    const snapshot: BrowsingCatalogSnapshot = { provider: `claude`, verifiedAt: 1, models: [model(`5`)] };
    const store = memory([snapshot]);
    const warn = jest.fn();
    await refreshBrowsingCatalog(store, sources, { warn }, async () => { throw new Error(`private upstream failure`); }, () => BROWSING_CATALOG_MAX_AGE_MS);
    expect(await store.read()).toEqual([snapshot]);
    expect(await browseModels(store, sources, BROWSING_CATALOG_MAX_AGE_MS)).toEqual({ catalogs: [snapshot] });
    expect(await browseModels(store, sources, BROWSING_CATALOG_MAX_AGE_MS + 1)).toEqual({ catalogs: [] });
    expect(warn).toHaveBeenCalledWith({ provider: `claude` }, `model catalog refresh failed; retaining the last successful discovery`);
});

test(`a broken integration does not prevent another integration refreshing`, async () => {
    const both = [...sources, { ...sources[0]!, provider: `codex` as const }];
    const store = memory();
    await refreshBrowsingCatalog(store, both, { warn: jest.fn() }, async (source) => {
        if (source.provider === `claude`) { throw new Error(`refused`); }
        return [{ id: `gpt-22`, label: `GPT 22` }];
    }, () => 100);
    expect(await browseModels(store, both, 100)).toEqual({ catalogs: [{ provider: `codex`, verifiedAt: 100, models: [{ id: `gpt-22`, label: `GPT 22` }] }] });
});

test(`the public route is cacheable and an unconfigured source withdraws a stored catalog`, async () => {
    const snapshot: BrowsingCatalogSnapshot = { provider: `claude`, verifiedAt: Date.now(), models: [model(`12`)] };
    const store = memory([snapshot]);
    const response = await modelCatalogRoutes(store, sources).request(`/api/model-catalog`);
    expect(response.status).toBe(200);
    expect(response.headers.get(`cache-control`)).toBe(`public, max-age=300`);
    expect(await response.json()).toEqual({ catalogs: [snapshot] });
    expect(await browseModels(store, [], snapshot.verifiedAt)).toEqual({ catalogs: [] });
});
