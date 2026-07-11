import { oc } from "@orpc/contract";
import { DraftIdParamSchema, DraftsListSchema, DraftSummarySchema, OkSchema } from "../schemas.js";

// The sandbox's post-drafts queue (agent-proposed posts awaiting approval). The agent creates draft files
// directly — these routes are the OWNER's side: `list` is the approval inbox, `upsert` covers approve / edit /
// retry (all a plain re-post with a field changed, like the automations enabled toggle), `remove` is reject.
export const draftsContract = {
    list: oc.route({ method: "GET", path: "/drafts" }).output(DraftsListSchema),
    upsert: oc.route({ method: "POST", path: "/drafts" }).input(DraftSummarySchema).output(OkSchema),
    remove: oc.route({ method: "DELETE", path: "/drafts/{id}" }).input(DraftIdParamSchema).output(OkSchema),
};
