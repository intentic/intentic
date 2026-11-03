import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { planApproval } from "../../../prompt/plan-revision.js";

/** The approved notes ride ExitPlanMode's result, before Claude can execute its next step. */
export const planApprovalContext = () => {
    let instructions: string | undefined;
    return {
        accept: (feedback: string | undefined): void => {
            instructions = feedback?.trim() ? planApproval(feedback) : undefined;
        },
        hooks: {
            PostToolUse: [{
                matcher: "^ExitPlanMode$",
                hooks: [async (input) => {
                    if (input.hook_event_name !== "PostToolUse" || input.tool_name !== "ExitPlanMode" || instructions === undefined) {
                        return {};
                    }
                    const additionalContext = instructions;
                    instructions = undefined;
                    return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } };
                }],
            }],
        } satisfies Partial<Record<HookEvent, HookCallbackMatcher[]>>,
    };
};
export type PlanApprovalContext = ReturnType<typeof planApprovalContext>;
