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
// runs + next fire time. `upsert` adds or edits by id (nothing to provision — the scheduler picks it up on its
// next poll); `setEnabled` changes only the switch, so a list-row action never has to reconstruct the record.
// `remove` deletes.
// The `pending*` routes are the owner's approval queue: a `requireApproval` automation holds each fire here
// instead of waking; `approve` runs the held wake, `reject` drops it.
export const automationsContract = {
    list: oc.route({ method: "GET", path: "/automations" }).output(AutomationsListSchema),
    /* WHAT CAN WAKE AN AGENT HERE, and what to start from — the daemon's own sources and templates merged with
     * every installed extension's. The composer's entire vocabulary, so that adding a trigger to an area is a
     * change to that area and to nothing else. `upsert` below validates against the same merge, which is what
     * keeps the surface and the daemon from disagreeing about what is allowed. */
    catalog: oc.route({ method: "GET", path: "/automations/catalog" }).output(AutomationCatalogSchema),
    upsert: oc.route({ method: "POST", path: "/automations" }).input(AutomationSchema).output(OkSchema),
    setEnabled: oc.route({ method: "POST", path: "/automations/{id}/enabled" }).input(AutomationEnabledInputSchema).output(OkSchema),
    remove: oc.route({ method: "DELETE", path: "/automations/{id}" }).input(AutomationIdParamSchema).output(OkSchema),
    /* Fire one automation NOW, by hand — the answer to "I wrote a 3 a.m. cron and I have no way to try it".
     * It runs the SAME path the real trigger runs: a schedule stays a headless main-tree wake, because a
     * test-fire that proves an isolated worktree works proves nothing about the fire it is standing in for. The
     * guard runs too ("skipped by guard" is the most useful thing this can report); only the approval gate is
     * skipped, since pressing the button IS the owner's approval.
     *
     * Owner-explicit, so a DISABLED automation fires as well — trying a prompt before switching it on is the
     * main reason to press this, and unlike the /automations/{id}/fire webhook there is no outside sender here to
     * fail closed against.
     *
     * Acks immediately with the turn detached, like /fire and `approve`: the guard alone may take a minute, and
     * the run history (with the session that makes it openable) is where the outcome lands. */
    run: oc.route({ method: "POST", path: "/automations/{id}/run" }).input(AutomationIdParamSchema).output(OkSchema),
    pendingList: oc.route({ method: "GET", path: "/automations/pending" }).output(AutomationApprovalsListSchema),
    approve: oc.route({ method: "POST", path: "/automations/pending/{id}/approve" }).input(AutomationApprovalIdParamSchema).output(OkSchema),
    reject: oc.route({ method: "POST", path: "/automations/pending/{id}/reject" }).input(AutomationApprovalIdParamSchema).output(OkSchema),
};
