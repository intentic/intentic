import { expect, test } from "vitest";
import { agentSessionName, bashTmuxHooks } from "./agent-terminals.js";

const hook = bashTmuxHooks().PreToolUse?.[0]?.hooks[0];
if (hook === undefined) {
    throw new Error("PreToolUse hook not registered");
}

const preToolUse = (toolInput: unknown, sessionId = "3f2a9b1c-0000-0000-0000-000000000000") =>
    hook(
        {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: toolInput,
            tool_use_id: "tu-1",
            session_id: sessionId,
            transcript_path: "/tmp/t",
            cwd: "/work",
        },
        "tu-1",
        { signal: new AbortController().signal },
    );

const rewritten = async (toolInput: unknown): Promise<string | undefined> => {
    const output = await preToolUse(toolInput);
    const updated = output.hookSpecificOutput?.hookEventName === "PreToolUse" ? output.hookSpecificOutput.updatedInput : undefined;
    return updated?.["command"] as string | undefined;
};

test("wraps the command in tmux-run under the session's agent-* tmux session", async () => {
    const command = await rewritten({ command: "echo hi", description: "Say Hi!" });
    expect(command).toBe("/usr/local/bin/tmux-run agent-3f2a9b1c 'echo hi' say-hi");
});

test("single-quotes in the command survive the rewrite", async () => {
    const command = await rewritten({ command: "echo 'a b'" });
    expect(command).toBe(`/usr/local/bin/tmux-run agent-3f2a9b1c 'echo '\\''a b'\\''' run`);
});

test("keeps the tool input's other fields", async () => {
    const output = await preToolUse({ command: "sleep 1", run_in_background: true, timeout: 5000 });
    const updated = output.hookSpecificOutput?.hookEventName === "PreToolUse" ? output.hookSpecificOutput.updatedInput : undefined;
    expect(updated?.["run_in_background"]).toBe(true);
    expect(updated?.["timeout"]).toBe(5000);
});

test("leaves non-string commands and already-wrapped commands alone", async () => {
    expect(await preToolUse({ command: 42 })).toEqual({});
    expect(await preToolUse({ command: "/usr/local/bin/tmux-run agent-x 'ls' run" })).toEqual({});
});

test("agentSessionName derives the same agent-* name the hook routes commands through", () => {
    expect(agentSessionName("3f2a9b1c-0000-0000-0000-000000000000")).toBe("agent-3f2a9b1c");
    // Empty after sanitizing the charset ⇒ no valid session name.
    expect(agentSessionName("!@#$")).toBeUndefined();
    expect(agentSessionName("")).toBeUndefined();
});
