import { noteAudit } from "../audit/audit-http.js";
import { foldPath } from "@intentic/sandbox-contract/policy/fence-paths";
import { areasContract } from "@intentic/sandbox-contract/contracts/areas.contract";
import { holdsRight } from "@intentic/sandbox-contract/schemas/members";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";

// The named parts of the workspace. Reading them is every member's business — a fenced person is shown the name of the
// fence they are behind, and a picker cannot offer what it cannot list — but writing one decides who sees what, which
// is for whoever runs people and access: the owner, Full access, or a member given People & access. That last one never
// moves an area they are fenced to themselves, since that would widen their own fence.

export type AreasRoutesDeps = Pick<Services, "areas" | "members" | "auth" | "wsTickets" | "mediaTickets">;

// Undefined identity is the owner's own tool (loopback, a panel), which is already inside the fence.
const refuseUnlessPeople = (context: OrpcContext, id: string): void => {
    const identity = context.identity;
    if (identity === undefined) {
        return;
    }
    if (!holdsRight(identity, "people")) {
        throw new ORPCError("FORBIDDEN", { message: "only someone who runs people and access decides who sees which folders" });
    }
    if (identity.role !== "owner" && identity.role !== "maintainer" && identity.areas?.includes(id) === true) {
        throw new ORPCError("FORBIDDEN", { message: `"${id}" is an area you are fenced to: the owner or someone with Full access changes it` });
    }
};

export const createAreasRoutes = (services: AreasRoutesDeps) => {
    const i = implement(areasContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async () => ({ areas: await services.areas.list() })),
        save: i.save.handler(async ({ input, context }) => {
            refuseUnlessPeople(context, input.id);
            // Folded on the way in, and deduped after: `./a/`, `a` and `a/b/..` name one folder, and an area listing
            // it three times would read as three grants of the same thing.
            const folders = [...new Set(input.folders.map((folder) => foldPath(folder) ?? folder))];
            const before = (await services.areas.get(input.id))?.folders ?? [];
            noteAudit({ target: input.id, details: { folders: folders.length, previousFolders: before.length } });
            await services.areas.upsert({ ...input, folders });
            // A holder's open streams filter against the folders read when they opened; closing them makes their
            // reconnect read these. Their media and download tickets name files the old folders reached, so they go too.
            // A relabel moves no folder and closes nothing.
            const moved = before.length !== folders.length || before.some((folder) => !folders.includes(folder));
            if (moved) {
                for (const member of await services.members.list()) {
                    if (member.areas?.includes(input.id) === true) {
                        services.auth?.connections.revoke(member.email);
                        services.wsTickets.revoke(member.email);
                        services.mediaTickets.revoke(member.email);
                    }
                }
            }
            return { ok: true as const };
        }),
        remove: i.remove.handler(async ({ input, context }) => {
            refuseUnlessPeople(context, input.id);
            // Named holders, not a count: "still held" is unactionable, and every name here is one the owner may
            // already read on the Access screen.
            const holders = (await services.members.list())
                .filter((member) => member.areas?.includes(input.id) === true)
                .map((member) => member.email);
            if (holders.length > 0) {
                throw new ORPCError("CONFLICT", { message: `still held by ${holders.join(", ")}; move them off it first` });
            }
            await services.areas.remove(input.id);
            return { ok: true as const };
        }),
    };
};
