import type { ApprovalSummary } from "@intentic/sandbox-contract";
import { APPROVAL_HOLD_MS, approvalsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { requireMaintainer } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { approveHookSet, dismissHookSet, hookRequests } from "../guard/hook-approvals.js";
import { forgetApprovals, recordApproval } from "./approval-decisions.js";
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
// An approve is the one write that also records the owner's yes, off the workspace (approval-decisions.ts), and only a
// person's session gives it: the bearer check refuses the panel and control tokens, since a program in the sandbox
// approving its own proposal is the very thing the queue exists to stop. The yes is recorded before the file is written
// and dropped before any other write or a reject, so the executor never reads a file ahead of the yes it carries.
export const createApprovalsRoutes = (services: Services) => {
    const i = implement(approvalsContract).$context<OrpcContext>();
    const roots = { historyRoot: services.config.historyRoot, workspaceRoot: services.workspace.root };
    const rearm = (): void => {
        void approvalsExecutorFor(services)
            .arm()
            .catch((error: unknown) => services.logger.error({ err: error }, "re-arming the approvals executor failed"));
    };
    return {
        list: i.list.handler(() => services.approvals.list()),
        upsert: i.upsert.handler(async ({ input, context }) => {
            const item = withApprovalHold(input, Date.now());
            if (item.status === "approved") {
                await requireMaintainer(
                    services,
                    context.headers,
                    "only the owner or a maintainer, signed in, can approve; a program's token cannot",
                );
                await recordApproval(roots, item, context.identity?.email);
            } else {
                await forgetApprovals(roots.historyRoot, [item.id]);
            }
            await services.approvals.upsert(item);
            rearm();
            return { ok: true } as const;
        }),
        remove: i.remove.handler(async ({ input }) => {
            await forgetApprovals(roots.historyRoot, [input.id]);
            if (!(await services.approvals.remove(input.id))) {
                throw new ORPCError("NOT_FOUND", { message: "no approval with that id" });
            }
            rearm();
            return { ok: true } as const;
        }),
        hookRequests: i.hookRequests.handler(() => hookRequests(services.config.historyRoot)),
        // The contract already withholds these from the panel and control tokens; the bearer check refuses every other
        // machine credential, so only a person's session gives this yes.
        approveHooks: i.approveHooks.handler(async ({ input, context }) => {
            await requireMaintainer(services, context.headers, "only the owner or a maintainer can let hooks run");
            if (!(await approveHookSet(services.config.historyRoot, input.digest))) {
                throw new ORPCError("NOT_FOUND", { message: "no turn has found a hook set with that fingerprint" });
            }
            return { ok: true } as const;
        }),
        dismissHooks: i.dismissHooks.handler(async ({ input, context }) => {
            await requireMaintainer(services, context.headers, "only the owner or a maintainer can dismiss hooks");
            if (!(await dismissHookSet(services.config.historyRoot, input.digest))) {
                throw new ORPCError("NOT_FOUND", { message: "no turn has found a hook set with that fingerprint" });
            }
            return { ok: true } as const;
        }),
    };
};
