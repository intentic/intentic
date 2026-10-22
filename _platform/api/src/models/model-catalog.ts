import { BROWSING_CATALOG_REFRESH_MS, BrowsingCatalogSnapshotSchema, type BrowsingCatalog, type BrowsingCatalogSnapshot, currentBrowsingCatalog } from "@intentic/api-contract/ingress";
import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { JOB_MODEL_CATALOG, runExclusive } from "../jobs-lock.js";
import { catalogSources, type CatalogSource, discoverBrowsingModels } from "./catalog-sources.js";

// Narrow persistence seam: unit tests exercise refreshes and outages without a database or service credentials.
export interface BrowsingCatalogStore {
    readonly read: () => Promise<readonly BrowsingCatalogSnapshot[]>;
    readonly save: (snapshot: BrowsingCatalogSnapshot) => Promise<void>;
}

export const databaseCatalogStore = (prisma: PrismaClient): BrowsingCatalogStore => ({
    read: async () => (await prisma.modelCatalog.findMany()).flatMap((row) => {
        const parsed = BrowsingCatalogSnapshotSchema.safeParse({ ...row, verifiedAt: row.verifiedAt.getTime() });
        return parsed.success ? [parsed.data] : [];
    }),
    save: async (snapshot) => {
        const data = { verifiedAt: new Date(snapshot.verifiedAt), models: snapshot.models };
        await prisma.modelCatalog.upsert({ where: { provider: snapshot.provider }, create: { provider: snapshot.provider, ...data }, update: data });
    },
});

export const refreshBrowsingCatalog = async (
    store: BrowsingCatalogStore,
    sources: readonly CatalogSource[],
    logger: Pick<Logger, "warn">,
    discover: typeof discoverBrowsingModels = discoverBrowsingModels,
    now: () => number = Date.now,
): Promise<void> => {
    const previous = await store.read();
    for (const source of sources) {
        const snapshot = previous.find((entry) => entry.provider === source.provider);
        if (snapshot !== undefined && currentBrowsingCatalog(snapshot, now()) && now() - snapshot.verifiedAt < BROWSING_CATALOG_REFRESH_MS) {
            continue;
        }
        try {
            const models = await discover(source);
            await store.save(BrowsingCatalogSnapshotSchema.parse({ provider: source.provider, verifiedAt: now(), models }));
        } catch {
            // No raw error: a fetch failure can carry the credential-bearing request. Keep the previous verified time.
            logger.warn({ provider: source.provider }, `model catalog refresh failed; retaining the last successful discovery`);
        }
    }
};

export const browseModels = async (store: BrowsingCatalogStore, sources: readonly CatalogSource[], now = Date.now()): Promise<BrowsingCatalog> => ({
    // Removing a configured integration withdraws its public catalog even while its old snapshot remains in storage.
    catalogs: (await store.read()).filter((snapshot) => sources.some((source) => source.provider === snapshot.provider) && currentBrowsingCatalog(snapshot, now)),
});

export const startBrowsingCatalog = (prisma: PrismaClient, config: Config, logger: Logger): (() => void) => {
    const sources = catalogSources(config.modelCatalog.sources);
    if (sources.length === 0) {
        return () => {};
    }
    const store = databaseCatalogStore(prisma);
    const tick = (): void => {
        void runExclusive(config, JOB_MODEL_CATALOG, () => refreshBrowsingCatalog(store, sources, logger)).catch(() =>
            logger.warn(`model catalog refresh could not complete`),
        );
    };
    tick();
    // Check hourly; snapshots younger than six hours avoid upstream calls, including across replica restarts.
    const timer = setInterval(tick, 60 * 60_000).unref();
    return () => clearInterval(timer);
};
