import type { DraftSummary } from "@intentic/sandbox-contract";
import { APPROVAL_HOLD_MS, draftsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { draftsPublisherFor } from "./drafts-publisher.js";

/* WHAT APPROVAL ACTUALLY WRITES. An approved draft carrying no date of its own is dated one hold into the
 * future, and that date is the entire countdown: the queue renders it, the publisher sleeps until it, and
 * "put it back in review" cancels it. Storing the hold as a plain scheduledAt rather than as a fifth status is
 * what makes all three of those free, nothing new to persist, nothing new to reason about after a restart,
 * and one number in the place a scheduled post's date is already read.
 *
 * A DATE THE OWNER OR THE AGENT CHOSE IS LEFT ALONE, whether it is next Tuesday or ten minutes ago. Adding a
 * minute to a post already an hour late is not caution, it is a bug; and a post dated for Tuesday is held by
 * its own date already. Only the undated case is ambiguous, and only it gets the hold. */
export const withApprovalHold = (draft: DraftSummary, now: number): DraftSummary =>
    draft.status === "approved" && draft.scheduledAt === undefined ? { ...draft, scheduledAt: now + APPROVAL_HOLD_MS } : draft;

/* The drafts-queue routes, the OWNER's side of the agent-written draft files. `upsert` covers approve, edit,
 * reschedule and retry in one shape (a re-post with a field changed, like the automations enabled toggle);
 * `remove` is reject.
 *
 * EVERY WRITE RE-ARMS THE PUBLISHER, and it is every write rather than the interesting ones because the
 * publisher's deadline is derived from the whole queue: approving adds one, rescheduling moves one, rejecting
 * removes one, and putting a held post back in review takes the nearest deadline away entirely. Working out
 * which of those changed the soonest due time is the same read that arming already does, so the route does not
 * try to be clever about it, it says "something moved" and lets the publisher re-answer. Detached, because
 * the owner's click should return the moment the file is written, not after a directory read. */
export const createDraftsRoutes = (services: Services) => {
    const i = implement(draftsContract).$context<OrpcContext>();
    const rearm = (): void => {
        void draftsPublisherFor(services)
            .arm()
            .catch((error: unknown) => services.logger.error({ err: error }, "re-arming the drafts publisher failed"));
    };
    return {
        list: i.list.handler(() => services.drafts.list()),
        upsert: i.upsert.handler(async ({ input }) => {
            await services.drafts.upsert(withApprovalHold(input, Date.now()));
            rearm();
            return { ok: true } as const;
        }),
        remove: i.remove.handler(async ({ input }) => {
            if (!(await services.drafts.remove(input.id))) {
                throw new ORPCError("NOT_FOUND", { message: "no draft with that id" });
            }
            rearm();
            return { ok: true } as const;
        }),
    };
};
