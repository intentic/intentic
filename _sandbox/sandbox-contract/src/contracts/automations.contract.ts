import { oc } from "@orpc/contract";
import {
    AutomationApprovalIdParamSchema,
    AutomationApprovalsListSchema,
    AutomationCatalogSchema,
    AutomationEnabledInputSchema,
    AutomationIdParamSchema,
    AutomationSchema,
    AutomationsListSchema,
    OkSchema,
} from "../schemas.js";

// The sandbox's automations manifest (scheduled agent wake-ups). `list` returns each automation with its recent
// runs + next fire time. `upsert` adds or edits by id (nothing to provision, the scheduler picks it up on its
// next poll); `setEnabled` changes only the switch, so a list-row action never has to reconstruct the record.
// `remove` deletes.
// The `pending*` routes are the owner's approval queue: a `requireApproval` automation holds each fire here
// instead of waking; `approve` runs the held wake, `reject` drops it.
export const automationsContract = {
    list: oc
        .route({
            method: "GET",
            path: "/automations",
            summary: "Things that wake an agent on their own",
            description: "Every automation with its recent runs and when it fires next.",
        })
        .output(AutomationsListSchema),
    /* WHAT CAN WAKE AN AGENT HERE, and what to start from, the daemon's own sources and templates merged with
     * every installed extension's. The composer's entire vocabulary, so that adding a trigger to an area is a
     * change to that area and to nothing else. `upsert` below validates against the same merge, which is what
     * keeps the surface and the daemon from disagreeing about what is allowed. */
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
    /* Fire one automation NOW, by hand, the answer to "I wrote a 3 a.m. cron and I have no way to try it".
     * It runs the SAME path the real trigger runs: a schedule stays a headless main-tree wake, because a
     * test-fire that proves an isolated worktree works proves nothing about the fire it is standing in for. The
     * guard runs too ("skipped by guard" is the most useful thing this can report); only the approval gate is
     * skipped, since pressing the button IS the owner's approval.
     *
     * Owner-explicit, so a DISABLED automation fires as well, trying a prompt before switching it on is the
     * main reason to press this, and unlike the /automations/{id}/fire webhook there is no outside sender here to
     * fail closed against.
     *
     * NOT FOR A LISTENER, which is the one trigger whose fire is nothing without the thing that fired it. A
     * listener's prompt is a brief about handling the events riding with it, and by hand there are none, so the
     * button could only ever produce an agent told to handle events, handed none, asking where they went. Worse,
     * that pointless run took the automation's turn: a real mention arriving while it ran had to wait behind it.
     * Refused here rather than hidden in the UI alone, because the honest answer to "how do I test this" is to
     * send the bot a message, which costs nothing and tests the whole path.
     *
     * Acks immediately with the turn detached, like /fire and `approve`: the guard alone may take a minute, and
     * the run history (with the session that makes it openable) is where the outcome lands. */
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
