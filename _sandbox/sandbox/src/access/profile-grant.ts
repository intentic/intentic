import { type AccessProfile, profileAccess } from "@intentic/sandbox-contract/schemas/access-profiles";
import { accessRefusal, tierOf } from "@intentic/sandbox-contract/schemas/members";
import type { Services } from "../composition.js";
import type { MemberGrant } from "../auth/auth.js";
import { assistantsRefusal, reachablePersonas } from "../personas/persona-reach.js";

/* A PROFILE ON A PERSON'S ROW (docs/architecture/access.md). A row holding a profile carries that profile's answers written
   out, so every reader of the roster (the authorizer, the route floors, the platform's copy of the tier, the presence
   list) reads one shape; saving the profile writes every holder's row again. An answer the profile leaves out is no
   limit, which a grant says as `all`: silence would keep the row's previous limit (member-row.ts). */

/** The grant that writes a profile's answers onto a row: its tier, its answers, and the profile named. */
export const profileGrant = (profile: AccessProfile): MemberGrant => {
    const access = profileAccess(profile);
    return {
        role: tierOf(access),
        areas: profile.areas,
        agents: access.agents,
        edit: access.edit === "none" ? undefined : access.edit === "all" ? "all" : [...access.edit],
        lands: access.lands,
        credentials: profile.credentials ?? "all",
        aiAccounts: profile.aiAccounts ?? "all",
        tools: profile.tools ?? "all",
        assistants: profile.assistants ?? "all",
        profile: profile.id,
    };
};

export type ProfileCheckDeps = Pick<Services, "areas" | "personas">;

/**
 * Why a profile cannot be held, or undefined when it can: an access no grant could make, an area this workspace lacks, a
 * chat with nobody to talk to, or assistants that do not work in its areas. The same refusals the roster's grant route
 * makes, since a profile is a grant several people share.
 */
export const profileRefusal = async (services: ProfileCheckDeps, profile: AccessProfile): Promise<string | undefined> => {
    const access = profileAccess(profile);
    const refused = accessRefusal(access);
    if (refused !== undefined) {
        return refused;
    }
    const editing = access.edit === "all" || access.edit === "none" ? [] : access.edit;
    const named = [...new Set([...(profile.areas ?? []), ...editing])];
    if (named.length > 0) {
        const known = new Set((await services.areas.list()).map((area) => area.id));
        const missing = named.filter((id) => !known.has(id));
        if (missing.length > 0) {
            return `no such area: ${missing.join(", ")}`;
        }
    }
    const assistants = await assistantsRefusal(services, profile.areas, profile.assistants);
    if (assistants !== undefined) {
        return assistants;
    }
    if (access.agents === "chat" && (await reachablePersonas(services, profile.areas, profile.assistants)).length === 0) {
        return "no assistant works in its areas, so a guest holding it would have nobody to talk to; give an assistant a starting folder inside one of them";
    }
    return undefined;
};
