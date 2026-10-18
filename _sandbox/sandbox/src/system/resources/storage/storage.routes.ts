import { join } from "node:path";
import { politeGit } from "@intentic/base/git";
import { discoverRepos } from "../../../workspace/layout/repo-discovery.js";
import { checkoutCost } from "./checkout-cost.js";
import { readHistorySpace } from "./checkout-admission.js";
import { checkoutSpace } from "./checkout-space.js";
import { systemContract } from "@intentic/sandbox-contract/contracts/system.contract";
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
    const warnings = async () => {
        const historyDisk = await readHistorySpace(services.config.historyRoot)
            .then((space) => {
                const verdict = checkoutSpace(space, 0);
                return { ...space, floorBytes: verdict.floorBytes, low: !verdict.allowed };
            })
            .catch((error) => {
                services.logger.warn({ err: error }, "storage: could not read history volume space");
                return undefined;
            });
        const repos = ["root", ...(await discoverRepos(services.workspace.root))];
        const costs = await Promise.all(
            repos.map(async (repo) => {
                const dir = repo === "root" ? services.workspace.root : join(services.workspace.root, repo);
                try {
                    const head = (await politeGit(dir, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
                    return { repo, head, bytes: await checkoutCost(dir, head, politeGit) };
                } catch (error) {
                    services.logger.debug({ err: error, repo }, "storage: repository has no readable checkout cost");
                    return undefined;
                }
            }),
        );
        return { historyDisk, repositoryCheckouts: costs.filter((cost) => cost !== undefined) };
    };
    return {
        storage: i.storage.handler(async () => ({ ...(await storage.report()), ...(await warnings()) })),
        scanStorage: i.scanStorage.handler(async () => ({ ...(await storage.scan()), ...(await warnings()) })),
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
