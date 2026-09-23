import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { resolveCommandSecrets, type SecretAccess } from "../../secrets/secret-access.js";
import { hasSecretReferences } from "../../secrets/secret-registry.js";

// The no-tmux arm: when terminals are on, resolution happens inside the tmux wrapper's own rewrite instead, since hook
// order across separate matchers is the SDK's to decide. This one covers the configuration where that pipeline never
// runs.
export const secretCommandHooks = (secrets: SecretAccess): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
    PreToolUse: [
        {
            matcher: "Bash",
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== "PreToolUse") {
                        return {};
                    }
                    const tool = input.tool_input as { command?: unknown };
                    if (typeof tool.command !== "string" || !hasSecretReferences(tool.command)) {
                        return {};
                    }
                    const resolved = await resolveCommandSecrets(tool.command, secrets);
                    if ("refusal" in resolved) {
                        return {
                            hookSpecificOutput: {
                                hookEventName: "PreToolUse",
                                permissionDecision: "deny",
                                permissionDecisionReason: resolved.refusal,
                            },
                        };
                    }
                    return {
                        hookSpecificOutput: {
                            hookEventName: "PreToolUse",
                            updatedInput: { ...(tool as Record<string, unknown>), command: resolved.command },
                        },
                    };
                },
            ],
        },
    ],
});
