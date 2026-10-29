import { procedure } from "../protocol/route-meta.js";
import { OkSchema } from "../schemas/shared.js";
import { AccessProfileIdParamSchema, AccessProfileSavedSchema, AccessProfileSchema, AccessProfilesListSchema } from "../schemas/access-profiles.js";

// Access profiles (AccessProfileSchema): the hard half of access, named so people and services can share one. Reading
// them is a maintainer's business, who points services at them; writing one changes what everybody holding it may do,
// which is the decision a revokable grant must not make, so both writes are the owner's alone, checked in-route the
// way the roster is.
export const accessProfilesContract = {
    list: procedure
        .route({
            method: "GET",
            path: "/access/profiles",
            summary: "The access profiles",
            description:
                "Every access profile this sandbox grants, its own and its organisation's: the areas, connections, secrets, AI accounts and tools each lets its holders reach.",
        })
        .meta({ floor: "maintainer", right: "people" })
        .output(AccessProfilesListSchema),
    // Upsert by id, re-saving the same id edits that profile.
    save: procedure
        .route({
            method: "POST",
            path: "/access/profiles",
            summary: "Create or edit an access profile",
            description:
                "Writes the whole profile; sending an id that exists edits it. Everybody holding it changes with it: their roster rows are rewritten and their open connections closed, as a re-grade does. Answers with each person holding it and the tier they now hold.",
        })
        .meta({ right: "people" })
        .input(AccessProfileSchema)
        .output(AccessProfileSavedSchema),
    // Refused while anyone holds it: a row or a service pointing at a profile that no longer exists reaches nothing,
    // which nobody chose.
    remove: procedure
        .route({
            method: "DELETE",
            path: "/access/profiles/{id}",
            summary: "Delete an access profile",
            description:
                "Removes the profile. Refused while a person or a service still holds it; move them onto another profile, or onto answers of their own, first.",
        })
        .meta({ right: "people" })
        .input(AccessProfileIdParamSchema)
        .output(OkSchema),
};
