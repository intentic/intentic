import { oc } from "@orpc/contract";
import { ApprovalIdParamSchema, ApprovalsListSchema, ApprovalSummarySchema } from "../schemas/approvals.js";
import { OkSchema } from "../schemas/shared.js";

// The sandbox's approvals queue (things the agent prepared and may not do until the owner says yes). The agent
// creates the files directly, these routes are the OWNER's side: `list` is the inbox, `upsert` covers approve /
// edit / reschedule / retry (all a plain re-post with a field changed, like the automations enabled toggle),
// `remove` is reject. The verbs are the same whatever the kind, which is the point of one queue.
export const approvalsContract = {
    list: oc
        .route({
            method: "GET",
            path: "/approvals",
            summary: "Things waiting for your yes",
            description:
                "Everything an agent has prepared and would like to do: posts to publish, actions to carry out. Nothing here has happened yet.",
        })
        .output(ApprovalsListSchema),
    upsert: oc
        .route({
            method: "POST",
            path: "/approvals",
            summary: "Approve, edit or retry one",
            description: "All three are the same act with a different field changed, so they share one call. Send the item back as you want it.",
        })
        .input(ApprovalSummarySchema)
        .output(OkSchema),
    remove: oc
        .route({
            method: "DELETE",
            path: "/approvals/{id}",
            summary: "Reject one",
            description: "Throws it away undone.",
        })
        .input(ApprovalIdParamSchema)
        .output(OkSchema),
};
