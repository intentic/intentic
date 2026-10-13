import type { PermissionRule } from "@opencode/client";
import { mcpToolKey, type OpenCodeMounts } from "../opencode-mcp.js";

// A turn's tool list (TurnPolicy.allowedTools) as OpenCode session rules. OpenCode 2 offers the model a tool only when the
// last rule matching the tool's permission action is not a wildcard deny, refuses a call to a tool it did not offer, and
// asks or denies by the same rules again when a tool runs. So a session that opens with `{*, *, deny}` is offered nothing,
// and each listed tool is added back by its own action. Checked against 2.0.26 with a scripted model reading what was
// offered (2026-10-12): its built-in tools are edit, glob, grep, question, read, shell, skill, subagent, webfetch,
// websearch and write, plus the code-mode runner `execute`; each is hidden by the wildcard deny and offered again only by
// an allow on its own action (edit and write share `edit`); an MCP tool's action is its key, `<server>_<tool>`; and a
// subagent's child session inherits its parent's session rules, so the list holds there too.
//
// The session's rules come after the server's and the agent's, and the last match wins. An allow added back here would
// therefore override what those ask or deny about the same action, so what they hold is appended again after the allows,
// for the listed actions only: an ask appended for an action off the list would offer its tool again.

// Claude's tool names as OpenCode's permission actions. A list naming a tool OpenCode does not have allows nothing here.
const ACTIONS: ReadonlyMap<string, string> = new Map([
    ["Bash", "shell"],
    ["Read", "read"],
    ["Glob", "glob"],
    ["Grep", "grep"],
    ["WebFetch", "webfetch"],
    ["WebSearch", "websearch"],
    ["Task", "subagent"],
    ["Agent", "subagent"],
    ["Skill", "skill"],
    ["AskUserQuestion", "question"],
]);

// OpenCode's `edit` action covers both its edit and write tools, so it is allowed only where the list names both: a list
// naming Edit alone would otherwise let the model write whole new files.
const EDIT_NEEDS = ["Edit", "Write"] as const;

// The actions that touch files, whose path outside the workspace OpenCode checks as `external_directory` as well. The
// server allows that (opencode-config.ts); the session's wildcard deny would take it back from a listed file tool.
const FILE_ACTIONS: ReadonlySet<string> = new Set(["read", "edit", "glob", "grep"]);

export interface AllowlistTurn {
    // The turn runs on a plan agent, whose read-only rule a listed edit must not override.
    readonly plan: boolean;
    // The asks the turn's mode adds (DEFAULT_MODE_ASKS), kept for the actions the list allows.
    readonly asks: readonly PermissionRule[];
    // The server's own asks (SERVER_PERMISSIONS), kept for the actions the list allows.
    readonly serverAsks: readonly PermissionRule[];
}

// The MCP actions one list entry allows, among the turn's own mounted servers: a whole server (`mcp__server`,
// `mcp__server__*`) or one tool (`mcp__server__tool`). Two mounted servers where one's key prefix starts the other's
// (`a_` and `a_b_`) are both left out, since no pattern could tell their tools apart.
const mcpActionsOf = (entry: string, mounts: OpenCodeMounts): string[] => {
    const match = /^mcp__(.+?)(?:__(.+))?$/.exec(entry);
    const server = match?.[1];
    if (server === undefined || !mounts.tools.some((tool) => tool.name === server)) {
        return [];
    }
    const own = mcpToolKey(mounts, server, "");
    const ambiguous = mounts.tools.some((tool) => {
        const other = mcpToolKey(mounts, tool.name, "");
        return tool.name !== server && (other.startsWith(own) || own.startsWith(other));
    });
    if (ambiguous) {
        return [];
    }
    const tool = match?.[2];
    return [tool === undefined || tool === "*" ? `${own}*` : mcpToolKey(mounts, server, tool)];
};

// The action a plain entry or a `Bash(...)` narrowing names; any other narrowing allows nothing, as tool-allowlist.ts
// reads one.
const builtInActionOf = (entry: string): string | undefined => {
    const narrowed = /^([^()]+)\((.*)\)$/s.exec(entry);
    if (narrowed !== null) {
        return narrowed[1]?.trim() === "Bash" ? "shell" : undefined;
    }
    return ACTIONS.get(entry);
};

/** The OpenCode actions a turn's list allows, built-in and MCP. */
export const allowedActions = (list: readonly string[], mounts: OpenCodeMounts): ReadonlySet<string> => {
    const entries = list.map((entry) => entry.trim());
    const actions = new Set<string>();
    for (const entry of entries) {
        const action = builtInActionOf(entry);
        if (action !== undefined) {
            actions.add(action);
        }
        for (const mcp of mcpActionsOf(entry, mounts)) {
            actions.add(mcp);
        }
    }
    if (EDIT_NEEDS.every((name) => entries.includes(name))) {
        actions.add("edit");
    }
    return actions;
};

/**
 * The session rules that hold a turn to its list: every tool denied, the listed ones allowed, then, for those only, the
 * asks the server and the turn's mode make, and the plan agent's read-only rule. A shell entry narrowed to a command is
 * not a rule OpenCode can match, so the shell is allowed whole and every command is asked about (the server's own ask),
 * and the turn's judge checks the command against the list (opencode-permissions.ts).
 */
export const allowlistRules = (list: readonly string[], mounts: OpenCodeMounts, turn: AllowlistTurn): PermissionRule[] => {
    const actions = allowedActions(list, mounts);
    const kept = (rule: PermissionRule): boolean => actions.has(rule.action);
    return [
        { action: "*", resource: "*", effect: "deny" },
        ...[...actions].map((action): PermissionRule => ({ action, resource: "*", effect: "allow" })),
        ...([...actions].some((action) => FILE_ACTIONS.has(action)) ? [{ action: "external_directory", resource: "*", effect: "allow" } as const] : []),
        ...turn.serverAsks.filter((rule) => rule.effect === "ask" && kept(rule)),
        ...turn.asks.filter(kept),
        ...(turn.plan && actions.has("edit") ? [{ action: "edit", resource: "*", effect: "deny" } as const] : []),
    ];
};
