import { accessProfilesContract } from "@intentic/sandbox-contract/contracts/access-profiles.contract";
import type { AccessProfile, AccessProfileSaved } from "@intentic/sandbox-contract/schemas/access-profiles";
import { holdsRight } from "@intentic/sandbox-contract/schemas/members";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import { noteAudit } from "../audit/audit-http.js";
import type { Services } from "../composition.js";
import { revokeHeld } from "../auth/members/revoke-held.js";
import { profileGrant, profileRefusal } from "./profile-grant.js";

// The access profiles (docs/architecture/access.md). A maintainer reads them, to point a service at one; writing one
// changes what everybody holding it may do, so both writes are for whoever runs people and access, as the roster's and
// the areas' are: the owner, Full access, or a member given People & access, who never rewrites the profile they hold.

export type AccessProfilesRoutesDeps = Pick<Services, "accessProfiles" | "services" | "members" | "areas" | "personas" | "auth" | "wsTickets" | "mediaTickets">;

// Undefined identity is the owner's own tool (loopback, a panel), which is already inside every fence.
const refuseUnlessPeople = async (services: AccessProfilesRoutesDeps, context: OrpcContext, id: string): Promise<void> => {
    const identity = context.identity;
    if (identity === undefined) {
        return;
    }
    if (!holdsRight(identity, "people")) {
        throw new ORPCError("FORBIDDEN", { message: "only someone who runs people and access decides what an access profile lets its holders reach" });
    }
    if (identity.role === "owner" || identity.role === "maintainer") {
        return;
    }
    const email = identity.email.toLowerCase();
    if ((await services.members.list()).some((member) => member.email.toLowerCase() === email && member.profile === id)) {
        throw new ORPCError("FORBIDDEN", { message: `"${id}" is the profile your own access comes from: the owner or someone with Full access changes it` });
    }
};

const refuseOrgProfile = async (services: AccessProfilesRoutesDeps, id: string): Promise<void> => {
    if ((await services.accessProfiles.get(id))?.origin === "org") {
        throw new ORPCError("FORBIDDEN", { message: `"${id}" is your organisation's profile: it is changed on the organisation's console, not here` });
    }
};

// Every person holding the profile, written again from it, their open connections closed as a re-grade closes them.
// One at a time through the roster's own write queue. Answers each with the tier their row now makes.
const rewriteHolders = async (services: AccessProfilesRoutesDeps, profile: AccessProfile): Promise<AccessProfileSaved["holders"]> => {
    const grant = profileGrant(profile);
    const holders = (await services.members.list()).filter((member) => member.profile === profile.id && member.role !== "maintainer");
    for (const holder of holders) {
        // one roster file, one write at a time through its own queue
        await services.members.add(holder.email, grant);
        revokeHeld(services, holder.email);
    }
    // A profile never manages (profileAccess), so its tier is never a maintainer's; narrowed here rather than asserted.
    const { role } = grant;
    if (role === "maintainer") {
        return [];
    }
    return holders.map((holder) => ({ email: holder.email.toLowerCase(), role }));
};

export const createAccessProfilesRoutes = (services: AccessProfilesRoutesDeps) => {
    const i = implement(accessProfilesContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async () => ({ profiles: await services.accessProfiles.list() })),
        save: i.save.handler(async ({ input, context }) => {
            await refuseUnlessPeople(services, context, input.id);
            await refuseOrgProfile(services, input.id);
            const refused = await profileRefusal(services, input);
            if (refused !== undefined) {
                throw new ORPCError("BAD_REQUEST", { message: refused });
            }
            noteAudit({ target: input.id, details: { areas: input.areas ?? "all", agents: input.agents ?? "run" } });
            await services.accessProfiles.upsert(input);
            return { ok: true as const, holders: await rewriteHolders(services, input) };
        }),
        remove: i.remove.handler(async ({ input, context }) => {
            await refuseUnlessPeople(services, context, input.id);
            await refuseOrgProfile(services, input.id);
            // Named holders, not a count: every name here is one the owner may already read on the Access page.
            const [members, held] = await Promise.all([services.members.list(), services.services.list()]);
            const holders = [
                ...members.filter((member) => member.profile === input.id).map((member) => member.email),
                ...held.filter((service) => service.profile === input.id).map((service) => `the service "${service.label ?? service.id}"`),
            ];
            if (holders.length > 0) {
                throw new ORPCError("CONFLICT", { message: `still held by ${holders.join(", ")}; move them off it first` });
            }
            noteAudit({ target: input.id });
            await services.accessProfiles.remove(input.id);
            return { ok: true as const };
        }),
    };
};
