import { oc } from "@orpc/contract";
import { DraftIdParamSchema, DraftsListSchema, DraftSummarySchema, OkSchema } from "../schemas.js";

// The sandbox's post-drafts queue (agent-proposed posts awaiting approval). The agent creates draft files
// directly, these routes are the OWNER's side: `list` is the approval inbox, `upsert` covers approve / edit /
// retry (all a plain re-post with a field changed, like the automations enabled toggle), `remove` is reject.
export const draftsContract = {
    list: oc
        .route({
            method: "GET",
            path: "/drafts",
            summary: "Posts waiting for your approval",
            description: "The queue of things an agent has written and would like to publish. Nothing here has gone anywhere yet.",
        })
        .output(DraftsListSchema),
    upsert: oc
        .route({
            method: "POST",
            path: "/drafts",
            summary: "Approve, edit or retry a draft",
            description: "All three are the same act with a different field changed, so they share one call. Send the draft back as you want it.",
        })
        .input(DraftSummarySchema)
        .output(OkSchema),
    remove: oc
        .route({
            method: "DELETE",
            path: "/drafts/{id}",
            summary: "Reject a draft",
            description: "Throws one away unposted.",
        })
        .input(DraftIdParamSchema)
        .output(OkSchema),
};
