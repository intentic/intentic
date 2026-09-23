import { procedure } from "../protocol/route-meta.js";
import { OkSchema } from "../schemas/shared.js";
import { AreaIdParamSchema, AreaSchema, AreasListSchema } from "../schemas/areas.js";

// Named parts of the workspace (AreaSchema), the unit a member's reach is granted in. Reading them is a member's own
// business — a fenced person is shown the name of the fence they are behind — but writing one changes who sees what,
// which is the one decision a revokable grant must not make, so the two writes below are owner-gated in-route the way
// the roster is.
export const areasContract = {
    list: procedure
        .route({
            method: "GET",
            path: "/areas",
            summary: "The named parts of the workspace",
            description:
                "Each area with the folders it admits. Access is granted in these rather than in folder lists per person, so widening what a team sees is one edit here instead of one edit per member.",
        })
        .meta({ guest: true })
        .output(AreasListSchema),
    // Upsert by id, re-saving the same id edits that area.
    save: procedure
        .route({
            method: "POST",
            path: "/areas",
            summary: "Create or edit an area",
            description:
                "Writes the whole area; sending an id that exists edits it. Editing the folders of an area people already hold changes what those people see on their next request, which is why this is the sandbox owner's to do and why the file it writes is tracked and reviewable.",
        })
        .input(AreaSchema)
        .output(OkSchema),
    // Refused while anyone still holds it: a member row pointing at an area that no longer exists would either fail
    // open (everything) or fail shut (nothing), and neither is a decision anybody made.
    remove: procedure
        .route({
            method: "DELETE",
            path: "/areas/{id}",
            summary: "Delete an area",
            description:
                "Removes the name and the folders behind it. Refused while a member still points at it, since nobody chose what such a row should then mean; move them onto another area first, or off areas entirely.",
        })
        .input(AreaIdParamSchema)
        .output(OkSchema),
};
