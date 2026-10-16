import type { ApprovedAction, ApprovedActionOutcome } from "@intentic/extension-api/runtime";
import { z } from "zod";

// The wire between the daemon's approvals executor and the backend host's `POST /approvals/<id>` door: one approved
// action in, its outcome out. Both ends parse with these, so the host (a child process that must not load the daemon's
// services) and the executor cannot drift on the shape.

const ApprovedActionSchema = z.object({
    id: z.string().min(1),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    summary: z.string(),
    details: z.string(),
    approver: z.string().optional(),
    approvedAt: z.number(),
    actionRules: z.record(z.string(), z.string()),
});

const ApprovalRequestSchema = z.object({ action: ApprovedActionSchema });

export const ApprovedActionOutcomeSchema: z.ZodType<ApprovedActionOutcome> = z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("done"), result: z.string() }),
    z.object({ outcome: z.literal("refused"), error: z.string() }),
    z.object({ outcome: z.literal("uncertain"), error: z.string() }),
]);

// The action a request to the door carries, or undefined for a body that is not one.
export const approvedActionIn = async (request: Request): Promise<ApprovedAction | undefined> => {
    // allow(silent-catch): a body that is not JSON is no action, which the door answers with a 400
    const body: unknown = await request.json().catch(() => undefined);
    return ApprovalRequestSchema.safeParse(body).data?.action;
};

export const approvalRequestBody = (action: ApprovedAction): string => JSON.stringify(ApprovalRequestSchema.parse({ action }));
