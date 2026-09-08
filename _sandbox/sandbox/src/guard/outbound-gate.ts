import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { AdmissionRule } from "@intentic/sandbox-contract";
import { classifyOutboundCall } from "../activity/outbound.js";
import { outboundSend } from "./actions.js";
import { guard } from "./guard.js";

// Enforcing half of the outbound sniffer: a PreToolUse hook on Bash, firing under bypassPermissions and for subagents.
// A hold refuses and points at the approvals queue instead of parking an unattended turn. Parses known command shapes;
// creative quoting can slip past, so this is policy, not a hard boundary.

const DRAFT_REDIRECT =
    "Instead of sending directly, write the message as an approval into .intentic/config/approvals/ (the approvals skill " +
    "has the format): the owner approves before anything posts, and that approval is what this rule asks for.";

export const outboundGateHooks = (rules: Readonly<Record<string, AdmissionRule>>): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
    PreToolUse: [
        {
            matcher: "Bash",
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== "PreToolUse") {
                        return {};
                    }
                    // The tmux hook may have rewrapped this command already; the inner command survives verbatim inside
                    // it.
                    const command = (input.tool_input as { command?: unknown }).command;
                    if (typeof command !== "string") {
                        return {};
                    }
                    const call = classifyOutboundCall(command);
                    if (call === undefined) {
                        return {};
                    }
                    const verdict = guard(outboundSend, { provider: call.provider, type: call.type, rules });
                    if (verdict.effect === "allow") {
                        return {};
                    }
                    return {
                        hookSpecificOutput: {
                            hookEventName: "PreToolUse",
                            permissionDecision: "deny",
                            permissionDecisionReason: verdict.effect === "hold" ? `${verdict.reason}. ${DRAFT_REDIRECT}` : verdict.reason,
                        },
                    };
                },
            ],
        },
    ],
});
