import type { DraftSummary } from "@intentic/sandbox-contract";
import { draftsContract, PUBLISH_DRAFTS_AUTOMATION } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { streamAgent } from "../agent/agent.routes.js";
import { fireAutomation } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

// Approved-and-due: the one state the publisher exists to act on. No file yet is simply "not yet".
const dueNow = (draft: DraftSummary | undefined, now: number): boolean =>
    draft !== undefined && draft.status === "approved" && (draft.scheduledAt ?? 0) <= now;

// Did THIS edit put the draft into approved-and-due? True for the approve click on an undated or past-dated
// draft, and for a reschedule that pulls an already-approved draft's date into the past — the two edits after
// which the owner is watching for the post to go out. False when it already was due (the publisher has it) and
// when the approval is for a future date (the sweep owns the calendar). Exported for its truth table.
export const becameDue = (prior: DraftSummary | undefined, next: DraftSummary, now: number): boolean => !dueNow(prior, now) && dueNow(next, now);

/* The drafts-queue routes — the OWNER's side of the agent-written draft files. `upsert` covers approve, edit,
 * and retry in one shape (a re-post with a field changed, like the automations enabled toggle); `remove` is
 * reject.
 *
 * APPROVAL IS ALSO THE MOMENT PUBLISHING IS OWED. An edit that makes a draft approved-and-due fires the
 * publisher automation right here instead of leaving the approval to wait for the sweep's next pass. The click
 * is the consent, so the fire carries the same clearance a by-hand Run-now does (`cleared: "approval"`); the
 * guard still re-reads the files, so a fire whose draft was deleted in the same breath skips instead of waking.
 * The publisher's own cron stays the net for everything a click cannot cover — future-dated drafts coming due,
 * and fires dropped because the publisher was already mid-turn. Deleted or disabled the automation? Then the
 * owner has switched publishing off, and approval goes back to meaning "ready whenever something posts it" —
 * the Automations page is where that state is visible. */
export const createDraftsRoutes = (services: Services) => {
    const i = implement(draftsContract).$context<OrpcContext>();
    return {
        list: i.list.handler(() => services.drafts.list()),
        upsert: i.upsert.handler(async ({ input }) => {
            const now = Date.now();
            const prior = (await services.drafts.list()).drafts.find((draft) => draft.id === input.id);
            await services.drafts.upsert(input);
            if (becameDue(prior, input, now)) {
                const publisher = await services.automations.get(PUBLISH_DRAFTS_AUTOMATION.id);
                if (publisher !== undefined && publisher.enabled) {
                    // Detached like every dispatcher's fire — the publish turn outlives this request.
                    void fireAutomation(services, publisher, streamAgent, { cleared: "approval" }).catch((error: unknown) =>
                        services.logger.error({ err: error, automation: publisher.id }, "publish-on-approval fire failed"),
                    );
                }
            }
            return { ok: true } as const;
        }),
        remove: i.remove.handler(async ({ input }) => {
            if (!(await services.drafts.remove(input.id))) {
                throw new ORPCError("NOT_FOUND", { message: "no draft with that id" });
            }
            return { ok: true } as const;
        }),
    };
};
