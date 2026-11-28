import { noteAudit } from "../audit/audit-http.js";
import type { ApprovalSummary, ApprovalUpsert } from "@intentic/sandbox-contract/schemas/approvals";
import type { AuthenticationResponse } from "@intentic/sandbox-contract/schemas/system";
import { APPROVAL_HOLD_MS } from "@intentic/sandbox-contract/policy/approvals-execution";
import { approvalsContract } from "@intentic/sandbox-contract/contracts/approvals.contract";
import { implement, ORPCError } from "@orpc/server";
import { requireMaintainer } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { approveHookSet, dismissHookSet, hookRequests } from "../guard/hook-approvals.js";
import { opt } from "../opt.js";
import { approvalCosign, approvalPasskeyOptions } from "./approval-cosign.js";
import { forgetApprovals, recordApproval } from "./approval-decisions.js";
import { approvalsExecutorFor } from "./approvals-executor.js";

// An approved item with no date gets one hold into the future as a plain scheduledAt; that date is the whole countdown
// (render, sleep, cancel-on-revert).
// A date the owner or the agent already chose is left alone, whether future or already past; only the undated case is
// ambiguous.
export const withApprovalHold = <T extends ApprovalSummary>(approval: T, now: number): T =>
    approval.status === "approved" && approval.scheduledAt === undefined ? { ...approval, scheduledAt: now + APPROVAL_HOLD_MS } : approval;

// (2026-11-28) The item an upsert carries, and the passkey assertion that co-signs its yes, which is never written into it.
const splitUpsert = (input: ApprovalUpsert) => {
    if (input.kind !== "action") {
        return { item: input satisfies ApprovalSummary, passkey: undefined };
    }
    const { passkey, ...item } = input;
    return { item: item satisfies ApprovalSummary, passkey: passkey satisfies AuthenticationResponse | undefined };
};

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
            const { item: asked, passkey } = splitUpsert(input);
            const item = withApprovalHold(asked, Date.now());
            noteAudit({ target: item.id, details: { status: item.status, ...opt("passkey", passkey === undefined ? undefined : true) } });
            if (item.status === "approved") {
                await requireMaintainer(
                    services,
                    context.headers,
                    "only the owner or a maintainer, signed in, can approve; a program's token cannot",
                );
                // (2026-11-28) A passkey co-signs the yes when one came, and must when the item's filer required it.
                const caller = { email: context.identity?.email, origin: context.headers.get("origin") ?? undefined };
                await recordApproval(roots, item, context.identity?.email, Date.now(), await approvalCosign(services, item, passkey, caller));
            } else {
                await forgetApprovals(roots.historyRoot, [item.id]);
            }
            await services.approvals.upsert(item);
            rearm();
            return { ok: true } as const;
        }),
        // (2026-11-28) The passkey request for co-signing one item's yes, for the person asking: a maintainer's session.
        passkeyOptions: i.passkeyOptions.handler(async ({ input, context }) => {
            await requireMaintainer(services, context.headers, "only the owner or a maintainer, signed in, can approve; a program's token cannot");
            const item = (await services.approvals.list()).approvals.find((each) => each.id === input.id);
            if (item === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no approval with that id" });
            }
            return approvalPasskeyOptions(services, item, { email: context.identity?.email, origin: context.headers.get("origin") ?? undefined });
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
