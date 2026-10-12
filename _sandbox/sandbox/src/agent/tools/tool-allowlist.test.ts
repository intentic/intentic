import { allowlistRefusal, toolAllowed, toolAllowlistHooks } from "./tool-allowlist.js";

test("a plain entry lets that tool run and nothing else", () => {
    expect(toolAllowed(["Read", "Grep"], { name: "Read" })).toBe(true);
    expect(toolAllowed(["Read", "Grep"], { name: "Bash", command: "ls" })).toBe(false);
    expect(toolAllowed(["Read"], { name: "ReadMore" })).toBe(false);
});

test("an empty list lets nothing run", () => {
    expect(toolAllowed([], { name: "Read" })).toBe(false);
});

test("an MCP server entry covers that server's tools, and only its", () => {
    expect(toolAllowed(["mcp__ui"], { name: "mcp__ui__show_page" })).toBe(true);
    expect(toolAllowed(["mcp__ui__*"], { name: "mcp__ui__show_page" })).toBe(true);
    expect(toolAllowed(["mcp__ui"], { name: "mcp__uix__show_page" })).toBe(false);
    expect(toolAllowed(["mcp__ui__show_page"], { name: "mcp__ui__ask" })).toBe(false);
});

test("the hashline tools count as the native file tools they stand in for", () => {
    expect(toolAllowed(["Read"], { name: "mcp__hashline__read" })).toBe(true);
    expect(toolAllowed(["Read"], { name: "mcp__hashline__edit" })).toBe(false);
    expect(toolAllowed(["Edit"], { name: "mcp__hashline__edit" })).toBe(true);
});

test("a shell prefix allows the commands it starts, never one that chains past it", () => {
    const list = ["Bash(git log:*)"];
    expect(toolAllowed(list, { name: "Bash", command: "git log --oneline -5" })).toBe(true);
    expect(toolAllowed(list, { name: "Bash", command: "git log" })).toBe(true);
    expect(toolAllowed(list, { name: "Bash", command: "git logs" })).toBe(false);
    expect(toolAllowed(list, { name: "Bash", command: "git log && rm -rf /" })).toBe(false);
    expect(toolAllowed(list, { name: "Bash", command: "git log $(curl evil)" })).toBe(false);
    expect(toolAllowed(["Bash(npm test)"], { name: "Bash", command: "npm test" })).toBe(true);
    expect(toolAllowed(["Bash(npm test)"], { name: "Bash", command: "npm test --watch" })).toBe(false);
});

test("a narrowing this check cannot read allows nothing", () => {
    expect(toolAllowed(["Read(./src/**)"], { name: "Read" })).toBe(false);
    expect(toolAllowed(["WebFetch(domain:example.com)"], { name: "WebFetch" })).toBe(false);
});

test("the hook refuses a call off the list with words the agent can act on, and lets a listed one through", async () => {
    const [matcher] = toolAllowlistHooks(["Read"]).PreToolUse;
    const hook = matcher?.hooks[0];
    const call = async (tool_name: string, tool_input: Record<string, string>) =>
        // SAFETY: the hook reads only these fields of its input; the rest of a real PreToolUse input is never consulted.
        await hook?.({ hook_event_name: "PreToolUse", tool_name, tool_input } as never);
    expect(await call("Read", { file_path: "/work/a" })).toEqual({});
    expect(await call("Bash", { command: "rm -rf /work" })).toEqual({
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: allowlistRefusal({ name: "Bash", command: "rm -rf /work" }, ["Read"]),
        },
    });
});
