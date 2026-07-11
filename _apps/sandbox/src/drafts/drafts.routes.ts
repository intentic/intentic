import { draftsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

// The drafts-queue routes — the OWNER's side of the agent-written draft files. `upsert` covers approve, edit,
// and retry in one shape (a re-post with a field changed, like the automations enabled toggle); `remove` is
// reject. Nothing to provision: the publish automation's guard re-reads the files on its next fire.
export const createDraftsRoutes = (services: Services) => {
    const i = implement(draftsContract).$context<OrpcContext>();
    return {
        list: i.list.handler(() => services.drafts.list()),
        upsert: i.upsert.handler(async ({ input }) => {
            await services.drafts.upsert(input);
            return { ok: true } as const;
        }),
        remove: i.remove.handler(async ({ input }) => {
            if (!(await services.drafts.remove(input.id))) {
                throw new ORPCError("NOT_FOUND", { message: "no draft with that id" });
            }
            return { ok: true } as const;
        }),
    };
};
