import { expect, test } from "vitest";
import { agentSessionName, bashTmuxHooks } from "./agent-terminals.js";

const hookOf = (hooks: ReturnType<typeof bashTmuxHooks>) => {
    const hook = hooks.PreToolUse?.[0]?.hooks[0];
    if (hook === undefined) {
        throw new Error("PreToolUse hook not registered");
    }
    return hook;
};

const preToolUse = (toolInput: unknown, hooks = bashTmuxHooks()) =>
    hookOf(hooks)(
        {
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: toolInput,
            tool_use_id: "tu-1",
            session_id: "3f2a9b1c-0000-0000-0000-000000000000",
            transcript_path: "/tmp/t",
            cwd: "/work",
        },
        "tu-1",
        { signal: new AbortController().signal },
    );

const rewritten = async (toolInput: unknown, hooks?: ReturnType<typeof bashTmuxHooks>): Promise<string | undefined> => {
    const output = await preToolUse(toolInput, hooks);
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
    expect(await preToolUse({ command: "/usr/local/bin/tmux-run -e FOO agent-x 'ls' run" }, bashTmuxHooks(undefined, ["FOO"]))).toEqual({});
});

test("forwards env key NAMES as sorted -e flags before the session — never values", async () => {
    const hooks = bashTmuxHooks(undefined, ["IMAP_PASSWORD_IMAP", "DISCORD_BOT_TOKEN_DISCORD"]);
    const command = await rewritten({ command: "echo hi", description: "Say Hi!" }, hooks);
    expect(command).toBe("/usr/local/bin/tmux-run -e DISCORD_BOT_TOKEN_DISCORD -e IMAP_PASSWORD_IMAP agent-3f2a9b1c 'echo hi' say-hi");
});

test("drops env keys that are not plain identifiers — they land unquoted in every rewritten command", async () => {
    const hooks = bashTmuxHooks(undefined, ["PATH", "bad key", "1BAD", "A=B"]);
    const command = await rewritten({ command: "echo hi" }, hooks);
    expect(command).toBe("/usr/local/bin/tmux-run -e PATH agent-3f2a9b1c 'echo hi' run");
});

test("agentSessionName derives the same agent-* name the hook routes commands through", () => {
    expect(agentSessionName("3f2a9b1c-0000-0000-0000-000000000000")).toBe("agent-3f2a9b1c");
    // Empty after sanitizing the charset ⇒ no valid session name.
    expect(agentSessionName("!@#$")).toBeUndefined();
    expect(agentSessionName("")).toBeUndefined();
});

test("an isolated turn's Bash joins the turn's namespace, inside the tmux wrapper", async () => {
    const anchor = { pid: 4321, cwd: "/work", plan: { worktree: "/history/worktrees/abc", root: "/work", modules: [] }, dispose: () => {} };
    const command = await rewritten({ command: "sed -i s/a/b/ x.ts", description: "edit" }, bashTmuxHooks(undefined, [], anchor));
    // tmux-run stays OUTSIDE: the server, the pane logs and the terminals panel are daemon-side, and only the
    // command the pane runs crosses into the namespace. Without this, `sed -i` would rewrite the shared tree
    // while the same turn's Edit tool wrote to the worktree.
    expect(command).toBe(
        `/usr/local/bin/tmux-run agent-3f2a9b1c 'nsenter --mount=/proc/4321/ns/mnt --wd='\\''/work'\\'' -- bash -c '\\''sed -i s/a/b/ x.ts'\\''' edit`,
    );
});

test("the rtk backend's prefix rides inside the namespace with the command it wraps", async () => {
    const anchor = { pid: 9, cwd: "/work", plan: { worktree: "/wt", root: "/work", modules: [] }, dispose: () => {} };
    const command = await rewritten({ command: "ls" }, bashTmuxHooks("rtk", [], anchor));
    expect(command).toContain(`bash -c '\\''rtk ls'\\''`);
    // rtk is the agent's own command line, so it must not run outside the tree the agent is working in.
    expect(command).not.toContain("-- rtk");
});
