import type { ApprovedAction, ApprovedActionOutcome, ApprovedPost } from "@intentic/extension-api/runtime";
import { z } from "zod";

// The wire between the daemon's approvals executor and the backend host's `POST /approvals/<id>` door: one approved
// action, or (2026-11-26) one approved post, in, its outcome out. Both ends parse with these, so the host (a child process that must not load the daemon's
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

// (2026-11-26) An approved post a card of the extension publishes on (`api.approvals.publish`).
const ApprovedPostSchema = z.object({
    id: z.string().min(1),
    platform: z.string().min(1),
    content: z.string().min(1),
    title: z.string().optional(),
    target: z.string().min(1),
    approver: z.string().optional(),
    approvedAt: z.number(),
    actionRules: z.record(z.string(), z.string()),
});

const ApprovalRequestSchema = z.union([z.object({ action: ApprovedActionSchema }), z.object({ post: ApprovedPostSchema })]);
type ApprovalRequest = { readonly action: ApprovedAction } | { readonly post: ApprovedPost };

export const ApprovedActionOutcomeSchema: z.ZodType<ApprovedActionOutcome> = z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("done"), result: z.string() }),
    z.object({ outcome: z.literal("refused"), error: z.string() }),
    z.object({ outcome: z.literal("uncertain"), error: z.string() }),
]);

// The action or post a request to the door carries, or undefined for a body that is neither.
export const approvalIn = async (request: Request): Promise<ApprovalRequest | undefined> => {
    // allow(silent-catch): a body that is not JSON is no action, which the door answers with a 400
    const body: unknown = await request.json().catch(() => undefined);
    return ApprovalRequestSchema.safeParse(body).data;
};

export const approvalRequestBody = (request: ApprovalRequest): string => JSON.stringify(ApprovalRequestSchema.parse(request));
