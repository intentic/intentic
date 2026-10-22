import {
    currentBrowsingCatalog,
    type BrowsingCatalog,
} from "@intentic/api-contract/ingress";
import { ref, shallowRef } from "vue";
import { errorMessage } from "@intentic/base/errors";
import type { ModelOption } from "./providerCatalog";

export interface BrowsingCatalogReader {
    readonly read: () => Promise<BrowsingCatalog>;
    readonly readCache: () => BrowsingCatalog | undefined;
    readonly writeCache: (catalog: BrowsingCatalog) => void;
    readonly reportFailure: (message: string) => void;
    readonly now: () => number;
}

const READ_EVERY_MS = 5 * 60_000;

// Independent of sandbox accounts and conversation selections. Even a fresh public catalog cannot run a turn.
export const createBrowsingCatalog = (reader: BrowsingCatalogReader) => {
    const snapshots = shallowRef<BrowsingCatalog["catalogs"]>([]);
    const clock = ref(reader.now());
    let readAt: number | undefined;
    let inFlight: Promise<void> | undefined;
    try {
        snapshots.value = reader.readCache()?.catalogs ?? [];
    } catch (error) {
        // Browser storage can be disabled or full; the network remains the source.
        reader.reportFailure(errorMessage(error));
    }
    const refresh = async (): Promise<void> => {
        clock.value = reader.now();
        if (readAt !== undefined && clock.value - readAt < READ_EVERY_MS) {
            return;
        }
        if (inFlight !== undefined) {
            return inFlight;
        }
        inFlight = (async () => {
            try {
                const catalog = await reader.read();
                snapshots.value = catalog.catalogs;
                readAt = reader.now();
                reader.writeCache(catalog);
            } catch (error) {
                // Preserve the verified timestamps through an outage; optionsFor drops snapshots past their limit.
                reader.reportFailure(errorMessage(error));
            } finally {
                clock.value = reader.now();
            }
        })().finally(() => { inFlight = undefined; });
        return inFlight;
    };
    const optionsFor = (provider: string): ModelOption[] => {
        const snapshot = snapshots.value.find((entry) => entry.provider === provider);
        return snapshot !== undefined && currentBrowsingCatalog(snapshot, clock.value)
            ? snapshot.models.map((model) => ({ value: model.id, label: model.label }))
            : [];
    };
    return { snapshots, clock, refresh, optionsFor };
};
