import { BROWSING_CATALOG_MAX_AGE_MS, type BrowsingCatalog } from "@intentic/api-contract/ingress";
import { createBrowsingCatalog } from "./browsingCatalog";

const published = (verifiedAt: number, version: string): BrowsingCatalog => ({ catalogs: [{
    provider: `claude`, verifiedAt, models: [{ id: `claude-opus-${version}`, label: `Claude Opus ${version}` }],
}] });

test(`a cached catalog paints immediately and an upstream refresh discovers a future release`, async () => {
    let at = 1000;
    const writeCache = jest.fn();
    const read = jest.fn(async () => published(at, `15`));
    const catalog = createBrowsingCatalog({ read, readCache: () => published(at - 1, `5`), writeCache, reportFailure: jest.fn(), now: () => at });
    expect(catalog.optionsFor(`claude`)).toEqual([{ value: `claude-opus-5`, label: `Claude Opus 5` }]);
    await Promise.all([catalog.refresh(), catalog.refresh()]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(catalog.optionsFor(`claude`)).toEqual([{ value: `claude-opus-15`, label: `Claude Opus 15` }]);
    expect(writeCache).toHaveBeenCalledWith(published(at, `15`));
    read.mockResolvedValueOnce(published(at + 5 * 60_000, `16`));
    await catalog.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    at += 5 * 60_000;
    await catalog.refresh();
    expect(read).toHaveBeenCalledTimes(2);
    expect(catalog.optionsFor(`claude`)).toEqual([{ value: `claude-opus-16`, label: `Claude Opus 16` }]);
});

test(`offline cached models expire without renewing their verification time and a later retry recovers`, async () => {
    let at = 1;
    const read = jest.fn<() => Promise<BrowsingCatalog>>(async () => { throw new Error(`offline`); });
    const reportFailure = jest.fn();
    const catalog = createBrowsingCatalog({ read, readCache: () => published(1, `5`), writeCache: jest.fn(), reportFailure, now: () => at });
    await catalog.refresh();
    expect(reportFailure).toHaveBeenCalledWith(`offline`);
    expect(catalog.optionsFor(`claude`)).toEqual([{ value: `claude-opus-5`, label: `Claude Opus 5` }]);
    at += BROWSING_CATALOG_MAX_AGE_MS;
    await catalog.refresh();
    expect(catalog.optionsFor(`claude`)).toEqual([]);
    expect(catalog.snapshots.value[0]?.verifiedAt).toBe(1);
    read.mockResolvedValueOnce(published(at, `15`));
    await catalog.refresh();
    expect(catalog.optionsFor(`claude`)).toEqual([{ value: `claude-opus-15`, label: `Claude Opus 15` }]);
});

test(`a restricted or full browser cache does not prevent network discovery`, async () => {
    const reportFailure = jest.fn();
    const catalog = createBrowsingCatalog({
        read: async () => published(1, `15`), readCache: () => { throw new Error(`disabled`); },
        writeCache: () => { throw new Error(`full`); }, reportFailure, now: () => 1,
    });
    await catalog.refresh();
    expect(catalog.optionsFor(`claude`)).toEqual([{ value: `claude-opus-15`, label: `Claude Opus 15` }]);
    expect(reportFailure.mock.calls).toEqual([[`disabled`], [`full`]]);
});
