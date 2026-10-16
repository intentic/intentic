import type { HookJSONOutput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

// HookJSONOutput is a union; only its synchronous half carries hookSpecificOutput, the field every hook suite asserts
// on. Throws if a hook answers in the async form instead.
export const syncHookOutput = (output: HookJSONOutput): SyncHookJSONOutput => {
    if ("async" in output) {
        throw new Error("the hook answered in its async form, which carries no hookSpecificOutput");
    }
    return output;
};
