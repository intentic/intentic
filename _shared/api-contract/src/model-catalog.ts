import { z } from "zod";
import { NATIVE_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";

// Public discovery metadata only. These rows advertise an integration; they never grant access or pick a turn's model.
export const BrowsingModelSchema = z.object({ id: z.string().min(1), label: z.string().min(1) });
export const BrowsingCatalogSnapshotSchema = z.object({
    provider: z.enum(NATIVE_PROVIDERS),
    verifiedAt: z.number().int().nonnegative(),
    models: z.array(BrowsingModelSchema).min(1),
});
export const BrowsingCatalogSchema = z.object({ catalogs: z.array(BrowsingCatalogSnapshotSchema) });
export type BrowsingCatalog = z.infer<typeof BrowsingCatalogSchema>;
export type BrowsingCatalogSnapshot = z.infer<typeof BrowsingCatalogSnapshotSchema>;

// Refresh every six hours. Past a week without a successful upstream read, advertise the provider without versions.
export const BROWSING_CATALOG_REFRESH_MS = 6 * 60 * 60_000;
export const BROWSING_CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
// A desktop clock a little behind the platform's must still accept a freshly verified response.
const CLOCK_SKEW_MS = 5 * 60_000;
export const currentBrowsingCatalog = (snapshot: BrowsingCatalogSnapshot, now: number): boolean =>
    snapshot.verifiedAt <= now + CLOCK_SKEW_MS && now - snapshot.verifiedAt < BROWSING_CATALOG_MAX_AGE_MS;
