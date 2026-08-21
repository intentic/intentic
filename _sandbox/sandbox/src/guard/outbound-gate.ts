import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { AdmissionRule } from "@intentic/sandbox-contract";
import { classifyOutboundCall } from "../activity/outbound.js";
import { outboundSend } from "./actions.js";
import { guard } from "./guard.js";

/* The ENFORCING half of the outbound sniffer. The activity tee (activity/outbound.ts) watches the turn's
 * frames after the fact, by then the curl has run. This is the same classifier moved in front of execution:
 * a PreToolUse hook on Bash, which fires even under bypassPermissions and for subagents too, so it holds for
 * exactly the turns the permission cards never see, the unattended automation wakes where the tool allowlist
 * used to be the only boundary.
 *
 * A verdict of "hold" cannot park the turn (nobody may be there to answer; a card would hang until timeout and
 * read as the agent freezing), so it refuses the live call and points the agent at the drafts outbox, a draft
 * awaiting owner approval IS the held form of a send, and the publish automation is the approved replay.
 *
 * Same honesty note as the audit tee: this parses the command shapes the provider skills teach. A creatively
 * quoted command can slip past, so the gate is policy for well-behaved flows and an audit trail for the rest,
 * the hard boundary for hostile inputs remains the automation's tool allowlist. Wired only when the owner has
 * written at least one action rule (turn-plan forwards none otherwise), so an unconfigured workspace pays
 * nothing here. */

const DRAFT_REDIRECT =
    "Instead of sending directly, write the message as a draft into .intentic/config/drafts/ (the drafts skill has the " +
    "format): the owner approves drafts before they post, and that approval is what this rule asks for.";

export const outboundGateHooks = (rules: Readonly<Record<string, AdmissionRule>>): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
    PreToolUse: [
        {
            matcher: "Bash",
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== "PreToolUse") {
                        return {};
                    }
                    // The tmux hook may already have rewrapped this command; the inner command survives
                    // verbatim inside the wrapper, so the classifier's URL match still lands.
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
