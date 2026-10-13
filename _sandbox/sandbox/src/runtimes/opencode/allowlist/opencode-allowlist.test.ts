import type { PermissionRule } from "@opencode/client";
import type { AgentTool } from "../../../agent/tools/agent-tools.js";
import { allowedActions, allowlistRules } from "./opencode-allowlist.js";
import { SERVER_PERMISSIONS } from "../opencode-config.js";
import { mcpToolKey, openCodeMounts } from "../opencode-mcp.js";
import { DEFAULT_MODE_ASKS } from "../opencode-permissions.js";

// A turn's tool list as the OpenCode session rules that hold it: what is offered, and what is still asked about.

const WEB: AgentTool = { name: "web", url: "http://127.0.0.1:7000/mcp/web" };
const UI: AgentTool = { name: "ui", url: "http://127.0.0.1:7000/mcp/ui" };
const mounts = openCodeMounts("chat-1", [WEB, UI]);
const BUILD = { plan: false, asks: [], serverAsks: SERVER_PERMISSIONS };

const DENY_ALL: PermissionRule = { action: "*", resource: "*", effect: "deny" };
const allow = (action: string): PermissionRule => ({ action, resource: "*", effect: "allow" });

test("Claude's tool names become OpenCode's actions, and a name OpenCode lacks allows nothing", () => {
    expect([...allowedActions(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Skill", "AskUserQuestion", "NotebookEdit"], mounts)]).toEqual([
        "read",
        "glob",
        "grep",
        "webfetch",
        "websearch",
        "subagent",
        "skill",
        "question",
    ]);
});

// OpenCode's edit and write tools share one action: allowing it for a list naming Edit alone would let the model write
// whole new files the list never named.
test("edits are allowed only where the list names both Edit and Write", () => {
    expect(allowedActions(["Edit"], mounts).has("edit")).toBe(false);
    expect(allowedActions(["Write"], mounts).has("edit")).toBe(false);
    expect(allowedActions(["Edit", "Write"], mounts).has("edit")).toBe(true);
});

test("a narrowed shell entry allows the shell whole, and any other narrowing allows nothing", () => {
    expect([...allowedActions(["Bash(git log:*)"], mounts)]).toEqual(["shell"]);
    expect([...allowedActions(["Read(./src/**)", "WebFetch(domain:example.com)"], mounts)]).toEqual([]);
});

test("an MCP entry allows one of this turn's own servers, whole or one tool, and never one it did not mount", () => {
    expect([...allowedActions(["mcp__web", "mcp__ui__ask", "mcp__elsewhere__run"], mounts)]).toEqual([`${mcpToolKey(mounts, "web", "")}*`, mcpToolKey(mounts, "ui", "ask")]);
    expect([...allowedActions(["mcp__web__*"], mounts)]).toEqual([`${mounts.prefix}web_*`]);
});

// Server `a` tool `b_c` and server `a_b` tool `c` have the same key: no pattern can tell them apart, so neither is allowed.
test("two servers whose tool keys could match each other's are both left out", () => {
    const clash = openCodeMounts("chat-1", [
        { name: "a", url: "http://127.0.0.1:1/a" },
        { name: "a_b", url: "http://127.0.0.1:1/ab" },
    ]);

    expect([...allowedActions(["mcp__a", "mcp__a_b", "mcp__a_b__c"], clash)]).toEqual([]);
});

test("the session denies everything, allows the listed actions, then keeps the server's shell ask after them", () => {
    expect(allowlistRules(["Bash(npm test)", "Read"], mounts, BUILD)).toEqual([
        DENY_ALL,
        allow("shell"),
        allow("read"),
        allow("external_directory"),
        { action: "shell", resource: "*", effect: "ask" },
    ]);
});

// An ask kept for an action off the list would offer its tool to the model again.
test("asks for actions off the list are not kept, and a list of no file tool keeps no outside-the-workspace allow", () => {
    expect(allowlistRules(["WebSearch"], mounts, { ...BUILD, asks: DEFAULT_MODE_ASKS })).toEqual([DENY_ALL, allow("websearch")]);
    expect(allowlistRules([], mounts, BUILD)).toEqual([DENY_ALL]);
});

test("a default-mode turn keeps its per-tool asks for the listed actions, and a plan agent its read-only rule", () => {
    expect(allowlistRules(["Edit", "Write", "WebFetch"], mounts, { plan: true, asks: DEFAULT_MODE_ASKS, serverAsks: SERVER_PERMISSIONS })).toEqual([
        DENY_ALL,
        allow("webfetch"),
        allow("edit"),
        allow("external_directory"),
        { action: "edit", resource: "*", effect: "ask" },
        { action: "webfetch", resource: "*", effect: "ask" },
        { action: "edit", resource: "*", effect: "deny" },
    ]);
});
