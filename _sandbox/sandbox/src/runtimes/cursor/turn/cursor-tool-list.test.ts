import type { SDKCustomTool } from "@cursor/sdk";
import {
    CUSTOM_TOOLS_SERVER,
    cursorToolsOption,
    hookToolRefusal,
    listedCustomTools,
    listedMcpServers,
    mcpToolName,
    mcpToolRefusal,
} from "./cursor-tool-list.js";

// A turn's tool list, written in Claude's names, as Cursor's three layers read it: the header's built-ins, the mounts, and
// the hooks' check of each call.

describe("the built-ins a list offers Cursor", () => {
    test("each Claude tool maps onto Cursor's vocabulary, and a narrowed shell still offers the shell", () => {
        expect(cursorToolsOption(["Read", "Bash(git log:*)"]).toSorted()).toEqual(["await", "read", "shell"]);
        expect(cursorToolsOption(["Edit"])).toEqual(["edit"]);
        expect(cursorToolsOption(["Write"]).toSorted()).toEqual(["delete", "edit"]);
        expect(cursorToolsOption(["Glob", "Grep"]).toSorted()).toEqual(["glob", "grep", "ls"]);
    });

    test("an MCP entry offers the MCP family, which carries the daemon's own tools too", () => {
        expect(cursorToolsOption(["mcp__ui__ask"])).toEqual(["mcp"]);
    });

    // tool-allowlist.ts reads only the shell's narrowing; any other allows nothing, so it must not widen the header.
    test("an empty list, or a narrowing nothing can read, offers no built-in at all", () => {
        expect(cursorToolsOption([])).toEqual([]);
        expect(cursorToolsOption(["Read(./src/**)"])).toEqual([]);
    });
});

describe("a call a hook sees", () => {
    test("the shell is held to a narrowed entry, by the command it runs", () => {
        const list = ["Bash(git log:*)"];
        expect(hookToolRefusal(list, "Shell", "git log --oneline")).toBeUndefined();
        expect(hookToolRefusal(list, "Shell", "git log; rm -rf /")).toContain("not on this turn's tool list");
        expect(hookToolRefusal(list, "Shell", "rm -rf build")).toContain("rm -rf build");
        // Typing into a running shell can't be read as a command, so only a list naming the shell whole allows it.
        expect(hookToolRefusal(list, "WriteShellStdin", undefined)).toContain("not on this turn's tool list");
        expect(hookToolRefusal(["Bash"], "WriteShellStdin", undefined)).toBeUndefined();
    });

    test("Cursor's executors answer to the Claude tools that cover them", () => {
        expect(hookToolRefusal(["Edit"], "Write", undefined)).toBeUndefined();
        expect(hookToolRefusal(["Edit"], "Delete", undefined)).toContain("not on this turn's tool list");
        expect(hookToolRefusal(["Glob"], "Grep", undefined)).toBeUndefined();
        expect(hookToolRefusal(["Glob"], "List", undefined)).toBeUndefined();
        expect(hookToolRefusal(["Read"], "Fetch", undefined)).toContain("not on this turn's tool list");
    });

    test("a tool nobody mapped is checked as itself, so no Claude list lets it past", () => {
        expect(hookToolRefusal(["Read", "Bash"], "ComputerUse", undefined)).toContain("not on this turn's tool list");
        expect(hookToolRefusal(["Read", "Bash"], "ReadLints", undefined)).toContain("not on this turn's tool list");
    });

    test("an MCP call is named as the Claude loop names it, the daemon's own tools by their own servers", () => {
        expect(mcpToolName("browser", "click")).toBe("mcp__browser__click");
        expect(mcpToolName(CUSTOM_TOOLS_SERVER, "ask")).toBe("mcp__ui__ask");
        expect(mcpToolName(CUSTOM_TOOLS_SERVER, "spawn")).toBe("mcp__subagents__spawn");
        expect(mcpToolRefusal(["mcp__browser"], "browser", "click")).toBeUndefined();
        expect(mcpToolRefusal(["mcp__browser__snapshot"], "browser", "click")).toContain("not on this turn's tool list");
        expect(mcpToolRefusal(["mcp__browser"], "crm", "list")).toContain("not on this turn's tool list");
    });
});

describe("what a list mounts", () => {
    test("only the servers an entry names", () => {
        const servers = { browser: { url: "http://x/b" }, crm: { url: "http://x/c" } };
        expect(Object.keys(listedMcpServers(servers, ["mcp__browser__click"]))).toEqual(["browser"]);
        expect(Object.keys(listedMcpServers(servers, undefined))).toEqual(["browser", "crm"]);
    });

    test("only the custom tools it allows, each checking the list again when called", async () => {
        const ran: string[] = [];
        const tool = (name: string): SDKCustomTool => ({
            description: name,
            inputSchema: { type: "object", properties: {} },
            execute: async () => {
                ran.push(name);
                return "ran";
            },
        });
        const listed = listedCustomTools({ ask: tool("ask"), spawn: tool("spawn") }, ["mcp__ui__ask"]);
        expect(Object.keys(listed)).toEqual(["ask"]);
        // SAFETY: the stand-in tools read nothing of the call's context.
        expect(await listed["ask"]?.execute({}, undefined as never)).toBe("ran");
        expect(ran).toEqual(["ask"]);
    });
});
