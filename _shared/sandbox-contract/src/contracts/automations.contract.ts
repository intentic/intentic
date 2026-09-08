import { oc } from "@orpc/contract";
import {
    AutomationApprovalIdParamSchema,
    AutomationApprovalsListSchema,
    AutomationCatalogSchema,
    AutomationEnabledInputSchema,
    AutomationIdParamSchema,
    AutomationSchema,
    AutomationsListSchema,
} from "../schemas/automations.js";
import { DoorTokenSchema, OkSchema } from "../schemas/shared.js";

// Automations manifest (scheduled agent wake-ups); `pending*` is the owner's approval queue for wakes a
// `requireApproval` automation holds instead of firing directly.
export const automationsContract = {
    list: oc
        .route({
            method: "GET",
            path: "/automations",
            summary: "Things that wake an agent on their own",
            description: "Every automation with its recent runs and when it fires next.",
        })
        .output(AutomationsListSchema),
    catalog: oc
        .route({
            method: "GET",
            path: "/automations/catalog",
            summary: "What can trigger an automation here",
            description:
                "Every trigger this sandbox understands and every template worth starting from, the daemon's own merged with each installed extension's. Writing an automation is checked against this same list, so a screen and the daemon can never disagree about what is allowed.",
        })
        .output(AutomationCatalogSchema),
    upsert: oc
        .route({
            method: "POST",
            path: "/automations",
            summary: "Create or edit an automation",
            description: "Writes an automation by id. Nothing needs provisioning: the scheduler picks it up on its next sweep.",
        })
        .input(AutomationSchema)
        .output(OkSchema),
    setEnabled: oc
        .route({
            method: "POST",
            path: "/automations/{id}/enabled",
            summary: "Turn an automation on or off",
            description: "Flips only the switch, so a row in a list can be toggled without rebuilding the whole record.",
        })
        .input(AutomationEnabledInputSchema)
        .output(OkSchema),
    remove: oc
        .route({
            method: "DELETE",
            path: "/automations/{id}",
            summary: "Delete an automation",
            description: "Removes it, so nothing fires from it again.",
        })
        .input(AutomationIdParamSchema)
        .output(OkSchema),
    rotateToken: oc
        .route({
            method: "POST",
            path: "/automations/{id}/rotate-token",
            summary: "Rotate an automation's webhook token or intake key",
            description:
                "Mints a new credential for the door this automation opens and retires the old one at once. Every caller has to be handed the new URL; that is the point. Refused for an automation with no door.",
        })
        .input(AutomationIdParamSchema)
        .output(DoorTokenSchema),
    // Skips only the approval gate, since pressing this button is the owner's approval.
    run: oc
        .route({
            method: "POST",
            path: "/automations/{id}/run",
            summary: "Fire an automation by hand",
            description:
                "The answer to writing something that runs at three in the morning and having no way to try it. It takes exactly the path the real trigger takes, including the check that decides whether there was anything to do, since skipped by the guard is the most useful thing this can tell you. A switched-off automation fires too, because trying it before switching it on is the main reason to press this. Not available for the trigger that listens for incoming messages, where a hand-fire would produce an agent asked to handle events and handed none; send the bot a message instead. Answers straight away and runs detached.",
        })
        .input(AutomationIdParamSchema)
        .output(OkSchema),
    pendingList: oc
        .route({
            method: "GET",
            path: "/automations/pending",
            summary: "Automations waiting for a yes",
            description: "The queue an automation set to ask first lands in each time it would have fired.",
        })
        .output(AutomationApprovalsListSchema),
    approve: oc
        .route({
            method: "POST",
            path: "/automations/pending/{id}/approve",
            summary: "Let a held automation run",
            description: "Releases one waiting automation and runs the wake it was holding. Answers straight away and runs detached.",
        })
        .input(AutomationApprovalIdParamSchema)
        .output(OkSchema),
    reject: oc
        .route({
            method: "POST",
            path: "/automations/pending/{id}/reject",
            summary: "Drop a held automation",
            description: "Throws one waiting fire away. The automation stays on, and the next trigger queues as usual.",
        })
        .input(AutomationApprovalIdParamSchema)
        .output(OkSchema),
};
