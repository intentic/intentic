import { foldPath, slicesContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";

// The named parts of the workspace. Reading them is every member's business — a fenced person is shown the name of the
// fence they are behind, and a picker cannot offer what it cannot list — but writing one decides who sees what, which
// is the decision a revokable grant must never make, so both writes are the owner's alone.

export type SlicesRoutesDeps = Pick<Services, "slices" | "members">;

// Undefined identity is the owner's own tool (loopback, a panel), which is already inside the fence.
const refuseUnlessOwner = (context: OrpcContext): void => {
    const role = context.identity?.role;
    if (role !== undefined && role !== "owner") {
        throw new ORPCError("FORBIDDEN", { message: "only the sandbox owner decides who sees which folders" });
    }
};

export const createSlicesRoutes = (services: SlicesRoutesDeps) => {
    const i = implement(slicesContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async () => ({ slices: await services.slices.list() })),
        save: i.save.handler(async ({ input, context }) => {
            refuseUnlessOwner(context);
            // Folded on the way in, and deduped after: `./a/`, `a` and `a/b/..` name one folder, and a slice listing
            // it three times would read as three grants of the same thing.
            const folders = [...new Set(input.folders.map((folder) => foldPath(folder) ?? folder))];
            await services.slices.upsert({ ...input, folders });
            return { ok: true as const };
        }),
        remove: i.remove.handler(async ({ input, context }) => {
            refuseUnlessOwner(context);
            // Named holders, not a count: "still held" is unactionable, and every name here is one the owner may
            // already read on the Access screen.
            const holders = (await services.members.list())
                .filter((member) => member.slices?.includes(input.id) === true)
                .map((member) => member.email);
            if (holders.length > 0) {
                throw new ORPCError("CONFLICT", { message: `still held by ${holders.join(", ")}; move them off it first` });
            }
            await services.slices.remove(input.id);
            return { ok: true as const };
        }),
    };
};
