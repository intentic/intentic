import { BROWSING_CATALOG_MAX_AGE_MS, currentBrowsingCatalog } from "./model-catalog.js";

test(`a desktop clock slightly behind the platform accepts fresh metadata, and stale or implausibly future data stays hidden`, () => {
    const now = BROWSING_CATALOG_MAX_AGE_MS * 2;
    const snapshot = { provider: `claude` as const, models: [{ id: `claude-opus-15`, label: `Claude Opus 15` }] };
    expect(currentBrowsingCatalog({ ...snapshot, verifiedAt: now + 60_000 }, now)).toBe(true);
    expect(currentBrowsingCatalog({ ...snapshot, verifiedAt: now + 24 * 60 * 60_000 }, now)).toBe(false);
    expect(currentBrowsingCatalog({ ...snapshot, verifiedAt: now - BROWSING_CATALOG_MAX_AGE_MS + 1 }, now)).toBe(true);
    expect(currentBrowsingCatalog({ ...snapshot, verifiedAt: now - BROWSING_CATALOG_MAX_AGE_MS }, now)).toBe(false);
});
