import type { McpServerConfig as CursorMcpServer, SDKCustomTool, ToolName } from "@cursor/sdk";
import { allowlistRefusal, toolAllowed } from "../../../agent/tools/tool-allowlist.js";
import { JS_TOOL_NAME } from "../../../seams/js-tool-names.js";

// A turn's tool list (TurnPolicy.allowedTools, written in Claude's names: `Bash(git log:*)`, `Read`, `mcp__server__tool`)
// held on Cursor's runtime, in three layers, each covering what the one before it cannot:
// - Cursor's `tools` option: the built-in tools the model is offered at all, sent as a request header Cursor's backend
//   enforces for the main loop and, with `local.subagentInherit` set, for every `Task` child (options.d.ts). A list that
//   names no MCP entry drops the whole MCP family, the daemon's own custom tools with it.
// - The daemon's mounts: only the remote MCP servers and custom tools the list names are mounted at all.
// - The hooks: every call Cursor's local executors run (the shell, file reads and writes, grep, list, fetch, every MCP
//   call) passes preToolUse or beforeMCPExecution first, and is checked against the list there (cursor-hooks.ts), which
//   is where `Bash(…)` narrowing is read: the header can only grant the shell whole. The custom tools never pass a hook
//   (the SDK runs them in its own executor), so their handlers check the list themselves (listedCustomTools).

// What one unnarrowed entry grants in Cursor's vocabulary. `Edit` covers Cursor's edit and its whole-file write, which
// run through one executor; `delete` rides `Write`, a whole-file write being as destructive. Glob's search runs through
// Cursor's grep executor and its listing through ls. `await` waits on a background shell or a child, so it rides either.
const GRANTS = new Map<string, readonly ToolName[]>([
    ["Bash", ["shell", "await"]],
    ["Read", ["read"]],
    ["Edit", ["edit"]],
    ["MultiEdit", ["edit"]],
    ["NotebookEdit", ["edit"]],
    ["Write", ["edit", "delete"]],
    ["Glob", ["glob", "ls"]],
    ["LS", ["ls"]],
    ["Grep", ["grep"]],
    ["WebFetch", ["webFetch"]],
    ["WebSearch", ["webSearch"]],
    ["Task", ["task", "await"]],
    ["Agent", ["task", "await"]],
    ["TodoWrite", ["updateTodos", "readTodos"]],
]);

// The tool an entry names, or undefined for a narrowing this check cannot read (tool-allowlist.ts: only the shell's is
// read, so `Read(./src/**)` grants nothing, and must not widen the header either).
const entryTool = (entry: string): string | undefined => {
    const narrowed = /^([^()]+)\((.*)\)$/su.exec(entry.trim());
    if (narrowed === null) {
        return entry.trim();
    }
    return narrowed[1]?.trim() === "Bash" ? "Bash" : undefined;
};

/** Cursor's `tools` option for a list: the built-ins it grants, `mcp` when it names any MCP entry. */
export const cursorToolsOption = (list: readonly string[]): ToolName[] => {
    const granted = new Set<ToolName>();
    for (const entry of list) {
        const tool = entryTool(entry);
        if (tool === undefined) {
            continue;
        }
        if (tool.startsWith("mcp__")) {
            granted.add("mcp");
        }
        for (const name of GRANTS.get(tool) ?? []) {
            granted.add(name);
        }
    }
    return [...granted];
};

// The names Cursor's hooks give its executors, as the Claude tools a list would name for them; a call is allowed when
// the list allows any of them. A name not here is checked as itself, so a tool nobody mapped is refused rather than let
// past (ComputerUse, RecordScreen, ReadLints: nothing a Claude list can name).
const HOOK_TOOLS = new Map<string, readonly string[]>([
    ["Shell", ["Bash"]],
    // Typing into a shell the turn already started: a list naming the shell whole allows it; one that narrowed it to
    // some commands cannot tell what the typing runs, so it does not.
    ["WriteShellStdin", ["Bash"]],
    ["Read", ["Read"]],
    ["Write", ["Write", "Edit", "MultiEdit", "NotebookEdit"]],
    ["Delete", ["Write"]],
    ["Grep", ["Grep", "Glob"]],
    ["List", ["LS", "Glob"]],
    ["Fetch", ["WebFetch"]],
    ["Task", ["Task", "Agent"]],
    ["FetchMcpResource", ["ReadMcpResourceTool"]],
    ["ListMcpResources", ["ListMcpResourcesTool"]],
]);

// Cursor's synthetic server for the SDK's custom tools (the custom-tools typings @cursor/sdk ships).
export const CUSTOM_TOOLS_SERVER = "custom-user-tools";

// The daemon's custom tools by the names the Claude Code loop mounts the same tools under, so one list means the same
// on both runtimes.
const CUSTOM_TOOL_NAMES = new Map<string, string>([
    ["ask", "mcp__ui__ask"],
    ["code", JS_TOOL_NAME],
    ["spawn", "mcp__subagents__spawn"],
    ["providers", "mcp__subagents__providers"],
    ["wait", "mcp__subagents__wait"],
    ["send", "mcp__subagents__send"],
    ["answer", "mcp__subagents__answer"],
    ["cancel", "mcp__subagents__cancel"],
    ["merge", "mcp__subagents__merge"],
    ["settle", "mcp__subagents__settle"],
]);

const customToolName = (tool: string): string => CUSTOM_TOOL_NAMES.get(tool) ?? `mcp__${CUSTOM_TOOLS_SERVER}__${tool}`;

/** An MCP call as a list names it: the daemon's own tools by their Claude names, any other server's as `mcp__s__t`. */
export const mcpToolName = (server: string, tool: string): string => (server === CUSTOM_TOOLS_SERVER ? customToolName(tool) : `mcp__${server}__${tool}`);

/** The refusal for a built-in call off the list, or undefined when the list allows it. `command` is the shell's. */
export const hookToolRefusal = (list: readonly string[], tool: string, command: string | undefined): string | undefined => {
    const names = HOOK_TOOLS.get(tool) ?? [tool];
    if (names.includes("Bash")) {
        return toolAllowed(list, { name: "Bash", command }) ? undefined : allowlistRefusal({ name: "Bash", command }, list);
    }
    return names.some((name) => toolAllowed(list, { name })) ? undefined : allowlistRefusal({ name: names[0] ?? tool }, list);
};

/** The refusal for an MCP call off the list, or undefined when the list allows it. */
export const mcpToolRefusal = (list: readonly string[], server: string, tool: string): string | undefined => {
    const name = mcpToolName(server, tool);
    return toolAllowed(list, { name }) ? undefined : allowlistRefusal({ name }, list);
};

// Whether any entry could allow some tool of this server: the whole server, its wildcard, or one of its tools.
const namesServer = (list: readonly string[], server: string): boolean =>
    list.some((entry) => {
        const tool = entry.trim();
        return tool === `mcp__${server}` || tool.startsWith(`mcp__${server}__`);
    });

/** The remote servers a list reaches; the rest are not mounted, so nothing of theirs is even offered. */
export const listedMcpServers = (servers: Record<string, CursorMcpServer>, list: readonly string[] | undefined): Record<string, CursorMcpServer> =>
    list === undefined ? servers : Object.fromEntries(Object.entries(servers).filter(([name]) => namesServer(list, name)));

/**
 * The custom tools a list allows, each checking the list again in its handler: Cursor runs them in its own executor,
 * past every hook, so the handler is the one place a call to one can be checked at all.
 */
export const listedCustomTools = (tools: Record<string, SDKCustomTool>, list: readonly string[] | undefined): Record<string, SDKCustomTool> => {
    if (list === undefined) {
        return tools;
    }
    return Object.fromEntries(
        Object.entries(tools)
            .filter(([name]) => toolAllowed(list, { name: customToolName(name) }))
            .map(([name, tool]) => [
                name,
                {
                    ...tool,
                    execute: async (args, context) => {
                        const refusal = mcpToolRefusal(list, CUSTOM_TOOLS_SERVER, name);
                        return refusal ?? tool.execute(args, context);
                    },
                } satisfies SDKCustomTool,
            ]),
    );
};
