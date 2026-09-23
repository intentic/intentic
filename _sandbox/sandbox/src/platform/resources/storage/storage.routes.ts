import { systemContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../../app-env.js";
import type { Services } from "../../../composition.js";
import { createDiskStorage } from "./disk-storage.js";
import { readRunningPrograms } from "./running-programs.js";

export type StorageRoutesDeps = Pick<Services, "config" | "workspace" | "logger">;

// The `system.*storage*` procedures, merged into `system` by router.ts, which also hands down `prune` (the workspace
// janitor's) from above both subsystems. One DiskStorage per router, so every caller shares one scan and one clean.
export const createStorageRoutes = (services: StorageRoutesDeps, prune: (storeDir: string) => Promise<boolean>) => {
    const i = implement(systemContract).$context<OrpcContext>();
    const storage = createDiskStorage({
        workspaceRoot: services.workspace.root,
        historyRoot: services.config.historyRoot,
        logger: services.logger,
        programs: () => readRunningPrograms(),
        prune,
    });
    return {
        storage: i.storage.handler(() => storage.report()),
        scanStorage: i.scanStorage.handler(() => storage.scan()),
        cancelStorageScan: i.cancelStorageScan.handler(() => {
            storage.cancel();
            return { ok: true } as const;
        }),
        cleanStorage: i.cleanStorage.handler(async ({ input }) => {
            const outcome = await storage.clean(input.category);
            if (outcome === "not cleanable") {
                throw new ORPCError("BAD_REQUEST", { message: `nothing in ${input.category} may be removed from here` });
            }
            if (outcome === "already cleaning") {
                throw new ORPCError("CONFLICT", { message: "another clean is still running; try again once it has finished" });
            }
            return outcome;
        }),
    };
};
