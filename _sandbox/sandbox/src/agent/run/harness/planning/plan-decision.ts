import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { PermissionMode } from "@intentic/sandbox-contract/schemas/agent";
import type { AgentRequest } from "../../../providers/agent-request.js";
import { planRevision } from "../../../prompt/plan-revision.js";

type PlanCard = Pick<Extract<AgentEvent, { kind: "plan" }>, "text" | "document">;

/** Raise the complete plan and wait for approval or revision before the SDK leaves plan mode. */
export const planApprovalDecision = (
    request: Pick<AgentRequest, "hooks" | "signal">,
    push: (event: AgentEvent) => void,
    cardOf: () => PlanCard | undefined,
    approved: (feedback: string | undefined) => Promise<PermissionMode>,
) => async (input: Record<string, unknown>): Promise<PermissionResult> => {
    const card = cardOf();
    if (card === undefined) {
        return { behavior: "deny", message: "Write the complete plan in your response, then call ExitPlanMode again." };
    }
    const { id, wait } = request.hooks.cards.create("plan", { kind: "plan", requestId: "", approve: false, feedback: "Planning cancelled." });
    push({ kind: "plan", requestId: id, ...card });
    const { reply, resolved } = await wait(request.signal);
    push(resolved);
    if (!reply.approve) {
        return { behavior: "deny", message: planRevision(reply.feedback) };
    }
    const mode = await approved(reply.feedback);
    return {
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: [{ type: "setMode", mode, destination: "session" }],
        decisionClassification: "user_temporary",
    };
};
