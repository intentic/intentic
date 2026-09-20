import { oc } from "@orpc/contract";
import { OkSchema } from "../schemas/shared.js";
import { SliceIdParamSchema, SliceSchema, SlicesListSchema } from "../schemas/slices.js";

// Named parts of the workspace (SliceSchema), the unit a member's reach is granted in. Reading them is a member's own
// business — a fenced person is shown the name of the fence they are behind — but writing one changes who sees what,
// which is the one decision a revokable grant must not make, so the two writes below are owner-gated in-route the way
// the roster is.
export const slicesContract = {
    list: oc
        .route({
            method: "GET",
            path: "/slices",
            summary: "The named parts of the workspace",
            description:
                "Each slice with the folders it admits. Access is granted in these rather than in folder lists per person, so widening what a team sees is one edit here instead of one edit per member.",
        })
        .output(SlicesListSchema),
    // Upsert by id, re-saving the same id edits that slice.
    save: oc
        .route({
            method: "POST",
            path: "/slices",
            summary: "Create or edit a slice",
            description:
                "Writes the whole slice; sending an id that exists edits it. Editing the folders of a slice people already hold changes what those people see on their next request, which is why this is the sandbox owner's to do and why the file it writes is tracked and reviewable.",
        })
        .input(SliceSchema)
        .output(OkSchema),
    // Refused while anyone still holds it: a member row pointing at a slice that no longer exists would either fail
    // open (everything) or fail shut (nothing), and neither is a decision anybody made.
    remove: oc
        .route({
            method: "DELETE",
            path: "/slices/{id}",
            summary: "Delete a slice",
            description:
                "Removes the name and the folders behind it. Refused while a member or a persona card still points at it, since nobody chose what such a row should then mean; move those onto another slice first, or off slices entirely.",
        })
        .input(SliceIdParamSchema)
        .output(OkSchema),
};
