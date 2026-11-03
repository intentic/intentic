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
import { createDiskStorage, type DiskStorageOptions } from "./disk-storage.js";
import { activeDiskPressure } from "./disk-pressure.js";
import { readRunningPrograms } from "./running-programs.js";
import { type CheckoutActions, CheckoutActionRefused, checkoutUsageOf } from "./checkout-usage.js";
import type { StorageReport } from "@intentic/sandbox-contract/schemas/metrics";

export type StorageRoutesDeps = Pick<Services, "config" | "workspace" | "logger">;

// The `system.*storage*` procedures, merged into `system` by router.ts, which also hands down `prune` (the workspace
// janitor's), the checkouts' build-output reaper and the per-conversation presses from above both subsystems. One
// DiskStorage per router, so every caller shares one scan and one clean.
export const createStorageRoutes = (
    services: StorageRoutesDeps,
    prune: (storeDir: string) => Promise<boolean>,
    buildOutputs?: DiskStorageOptions["buildOutputs"],
    checkouts?: CheckoutActions,
) => {
    const i = implement(systemContract).$context<OrpcContext>();
    const options: DiskStorageOptions = {
        workspaceRoot: services.workspace.root,
        historyRoot: services.config.historyRoot,
        logger: services.logger,
        programs: () => readRunningPrograms(),
        prune,
    };
    const storage = createDiskStorage(buildOutputs === undefined ? options : { ...options, buildOutputs });
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
    // The last scan's conversation directories with where each conversation stands now (checkout-usage.ts).
    const withCheckouts = async (report: StorageReport): Promise<StorageReport> => {
        const sizes = report.scan?.checkouts;
        if (checkouts === undefined || sizes === undefined) {
            return report;
        }
        return { ...report, checkouts: await checkoutUsageOf(sizes, checkouts.factsOf) };
    };
    // A refusal is the conversation's state, said as a conflict with its reason; anything else is a failure.
    const pressed = async <T>(press: (actions: CheckoutActions) => Promise<T>): Promise<T> => {
        if (checkouts === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "this sandbox does not keep conversation checkouts" });
        }
        try {
            return await press(checkouts);
        } catch (error) {
            if (error instanceof CheckoutActionRefused) {
                throw new ORPCError("CONFLICT", { message: error.message });
            }
            throw error;
        }
    };
    return {
        storage: i.storage.handler(async () => withCheckouts({ ...(await storage.report()), ...(await warnings()) })),
        scanStorage: i.scanStorage.handler(async () => withCheckouts({ ...(await storage.scan()), ...(await warnings()) })),
        diskPressure: i.diskPressure.handler(() => activeDiskPressure()),
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
        pressCheckout: i.pressCheckout.handler(({ input }) =>
            pressed(async (actions) => {
                switch (input.press) {
                    case "cleanBuildOutput":
                        return actions.clean(input.id);
                    case "release":
                        await actions.release(input.id);
                        return { id: input.id, removed: [] };
                    case "trash":
                        await actions.trash(input.id);
                        return { id: input.id, removed: [] };
                }
            }),
        ),
    };
};
