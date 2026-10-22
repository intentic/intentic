import { BrowsingCatalogSchema, ingressPath } from "@intentic/api-contract/ingress";
import { deviceKey, storedJson, storeJson } from "@intentic/ui/storage";
import { reportClient } from "../../app/clientDiagnostics";
import { environment } from "../../app/environments/environment";
import { createBrowsingCatalog } from "./browsingCatalog";

// Model names are public metadata, safe to retain across sandboxes. Namespace by platform for self-hosted deployments.
const cacheKey = deviceKey(`intentic:model-catalog:${environment.api.url}`);
export const browsingCatalog = createBrowsingCatalog({
    read: async () => {
        const response = await fetch(`${environment.api.url}${ingressPath(`modelCatalog`)}`, {
            credentials: `omit`, signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
            throw new Error(`model catalog returned ${response.status}`);
        }
        return BrowsingCatalogSchema.parse(await response.json());
    },
    readCache: () => storedJson(cacheKey, BrowsingCatalogSchema),
    writeCache: (catalog) => storeJson(cacheKey, catalog),
    reportFailure: (message) => reportClient(`models.browsing-catalog-unavailable`, `Model browsing is using the last verified catalog or offering connection.`, {
        level: `warn`, fields: { error: message },
    }),
    now: Date.now,
});
