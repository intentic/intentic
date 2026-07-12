import { historyContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

// Workspace history over the daemon-owned snapshots: list / per-snapshot diff / file diff / manual snapshot /
// restore. An unknown snapshot id is NOT_FOUND.
export const createHistoryRoutes = (services: Services) => {
    const i = implement(historyContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async () => ({ snapshots: await services.history.list() })),
        diff: i.diff.handler(async ({ input }) => {
            const changes = await services.history.diff(input.id);
            if (changes === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown snapshot" });
            }
            return { changes };
        }),
        fileDiff: i.fileDiff.handler(async ({ input }) => {
            const diff = await services.history.fileDiff(input.id, input.scope, input.path);
            if (diff === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "unknown snapshot or scope" });
            }
            return diff;
        }),
        snapshot: i.snapshot.handler(async () => {
            const id = await services.history.snapshot("manual");
            return id !== undefined ? { id } : {};
        }),
        restore: i.restore.handler(async ({ input }) => {
            if (!(await services.history.restore(input.id))) {
                throw new ORPCError("NOT_FOUND", { message: "unknown snapshot" });
            }
            return { ok: true } as const;
        }),
    };
};
