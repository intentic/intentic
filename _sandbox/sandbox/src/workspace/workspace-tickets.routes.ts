import { workspaceContract } from "@intentic/sandbox-contract/contracts/workspace.contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import {
    DOWNLOAD_TICKET_TTL_MS,
    type DownloadItem,
    type DownloadPlan,
    downloadBinding,
    nameSelection,
    pathExists,
} from "./files/download/workspace-download.js";
import { previewAddress, previewBinding, previewPlan, previewTicketTtl } from "./files/workspace-preview.js";
import { workspaceRootFor } from "./layout/workspace-scope.js";
import { workspaceReads } from "./workspace-reads.js";

// The tickets that stand in for a bearer where a browser cannot send one: a <video>'s range reads, a download the
// browser navigates to, a web page a frame loads with everything beside it. Each is minted guarded like a read, bound
// to what was resolved now, and named after its minter, so removing them or signing every browser out ends it
// (auth/tokens/media-tickets.ts). Beside workspace.routes.ts rather than in it: router.ts merges the two into the
// `workspace` group.
export const createWorkspaceTicketRoutes = (services: Services) => {
    const i = implement(workspaceContract).$context<OrpcContext>();
    const scope = services.workspaceScope;
    const { fenceFor, scopedRead } = workspaceReads(services);
    return {
        // Binds the resolved file, not its shared-tree namesake.
        mediaTicket: i.mediaTicket.handler(async ({ input, context }) => {
            const { target } = await scopedRead(context, input.agent, input.path);
            if ((await services.files.size(target)) === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "not found" });
            }
            return services.mediaTickets.mint(target, undefined, context.identity?.email);
        }),
        // Every path resolved now, so the plan the ticket carries names only what this caller could already open, in
        // the copy they asked for.
        downloadTicket: i.downloadTicket.handler(async ({ input, context }) => {
            const { names, filename } = nameSelection(input.paths, "workspace");
            const items: DownloadItem[] = [];
            for (const [path, name] of names) {
                const { target, shared } = await scopedRead(context, input.agent, path);
                if (!(await pathExists(target))) {
                    throw new ORPCError("NOT_FOUND", { message: `${path} is not there any more` });
                }
                items.push({ target, name, root: shared ? scope.main : await workspaceRootFor(scope, input.agent) });
            }
            const plan: DownloadPlan = { items, filename };
            return { ...services.mediaTickets.mint(downloadBinding(plan), DOWNLOAD_TICKET_TTL_MS, context.identity?.email), filename };
        }),
        // The page resolved in the copy asked for, and the folder it may read, the caller's fence and the page's unsaved
        // text fixed now (files/workspace-preview.ts).
        previewTicket: i.previewTicket.handler(async ({ input, context }) => {
            const { target, shared } = await scopedRead(context, input.agent, input.path);
            if (input.source === undefined && !(await pathExists(target))) {
                throw new ORPCError("NOT_FOUND", { message: "not found" });
            }
            const plan = await previewPlan({
                scope: shared ? scope.main : await workspaceRootFor(scope, input.agent),
                entry: target,
                fence: await fenceFor(context),
                source: input.source,
            });
            const { ticket, expiresAt } = services.mediaTickets.mint(previewBinding(plan), previewTicketTtl(plan), context.identity?.email);
            return { ...previewAddress(ticket, plan), expiresAt };
        }),
    };
};
