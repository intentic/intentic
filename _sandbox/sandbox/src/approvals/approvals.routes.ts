import type { ApprovalSummary } from "@intentic/sandbox-contract";
import { APPROVAL_HOLD_MS, approvalsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { approvalsExecutorFor } from "./approvals-executor.js";

// An approved item with no date gets one hold into the future as a plain scheduledAt; that date is the whole countdown
// (render, sleep, cancel-on-revert).
// A date the owner or the agent already chose is left alone, whether future or already past; only the undated case is
// ambiguous.
export const withApprovalHold = <T extends ApprovalSummary>(approval: T, now: number): T =>
    approval.status === "approved" && approval.scheduledAt === undefined ? { ...approval, scheduledAt: now + APPROVAL_HOLD_MS } : approval;

// The owner's side of the agent-written queue: `upsert` covers approve/edit/reschedule/retry in one shape, `remove` is
// reject.
// Every write re-arms the executor (detached) rather than reasoning about which write changed the soonest deadline; the
// re-read already does that.
export const createApprovalsRoutes = (services: Services) => {
    const i = implement(approvalsContract).$context<OrpcContext>();
    const rearm = (): void => {
        void approvalsExecutorFor(services)
            .arm()
            .catch((error: unknown) => services.logger.error({ err: error }, "re-arming the approvals executor failed"));
    };
    return {
        list: i.list.handler(() => services.approvals.list()),
        upsert: i.upsert.handler(async ({ input }) => {
            await services.approvals.upsert(withApprovalHold(input, Date.now()));
            rearm();
            return { ok: true } as const;
        }),
        remove: i.remove.handler(async ({ input }) => {
            if (!(await services.approvals.remove(input.id))) {
                throw new ORPCError("NOT_FOUND", { message: "no approval with that id" });
            }
            rearm();
            return { ok: true } as const;
        }),
    };
};
