import type { Logger } from "pino";
import type { StorageCleanResult } from "@intentic/sandbox-contract/schemas/metrics";
import { type Chore, DAY_MS } from "../../chore-clock.js";
import { readRunningPrograms, type RunningProgram } from "./running-programs.js";
import type { StorageRoots } from "./storage-catalog.js";
import { cleanCategory } from "./storage-clean.js";

/* EVERY PACKAGE STORE PRUNED DAILY (2026-11-18). The boot sweep pruned only `.intentic/local/.pnpm-store`
   (workspace/watch/state-janitor.ts); the two stores that grow, the workspace's `.pnpm-store` every checkout's install
   shares and a `.pnpm-store` pnpm makes at the top of the history volume when an install runs at a checkout's real path,
   were pruned only by a person pressing Clean on the Storage card. Measured on the intentic sandbox that day: 32.5 GB in
   the two, the history one 14.1 GB whose three registered projects were checkouts archived weeks before, and 14.6 GB of
   the workspace one linked from no node_modules.

   Daily, the Storage card's own clean of the category (storage-clean.ts): every store the catalog names, each handed to
   `pnpm store prune`, which removes what no registered project's node_modules uses, and none while any pnpm runs, since
   an install links from the store as it goes. A pass that met an install leaves every store for the next day. */

export interface PackageStoresDeps {
    // The volumes as the Storage scan resolves them (disk-storage.ts resolveStorageRoots), read at each run.
    readonly roots: () => Promise<StorageRoots>;
    // A store handed to its own tool's prune (state-janitor.ts pruneStore); resolves whether that ran.
    readonly prune: (storeDir: string) => Promise<boolean>;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly programs?: () => Promise<readonly RunningProgram[]>;
    readonly now?: () => number;
}

// One pass: what the clean freed, kept and failed, as the Storage card reports it.
export const prunePackageStores = async (deps: PackageStoresDeps): Promise<StorageCleanResult> => {
    const result = await cleanCategory("packageStores", {
        roots: await deps.roots(),
        now: deps.now ?? Date.now,
        programs: deps.programs ?? readRunningPrograms,
        prune: deps.prune,
    });
    if (result.freedBytes > 0 || result.failed > 0) {
        deps.logger.info({ storage: result }, `storage: pruned package stores, ${String(Math.round(result.freedBytes / 1e6))} MB freed`);
    }
    return result;
};

export const packageStoresChore = (deps: PackageStoresDeps): Chore => ({
    name: "package-stores",
    everyMs: DAY_MS,
    run: async () => void (await prunePackageStores(deps)),
});
