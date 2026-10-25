import type { PermissionRule } from "@opencode/client";
import { SERVER_PERMISSIONS } from "../opencode-config.js";
import { type OpenCodeMounts, sessionToolRules } from "../opencode-mcp.js";
import { DEFAULT_MODE_ASKS, type SessionJudge } from "../opencode-permissions.js";
import { allowlistRules, personaRules } from "./opencode-allowlist.js";

// Every tool denied, OpenCode's own included: the wildcard keeps this from tracking OpenCode's tool names in step.
const NO_TOOLS: readonly PermissionRule[] = [{ action: "*", resource: "*", effect: "deny" }];

// What of a turn its session's rules read.
export interface SessionRulesTurn {
    readonly sealed?: true;
    readonly approve?: unknown;
    readonly allowedTools?: readonly string[];
    readonly agent?: string;
    readonly persona?: SessionJudge["persona"];
}

/**
 * The rules a turn's session runs with: none for a sealed request; a turn's tool list, which denies everything else
 * (opencode-allowlist.ts); else its mounted servers' (opencode-mcp.ts). In `default` mode, the asks that put edits and
 * fetches on a per-tool card. Last, what the persona withholds (personaRules), which no rule before it may hand back.
 */
export const sessionRulesOf = (turn: SessionRulesTurn, mounts: OpenCodeMounts): PermissionRule[] => {
    if (turn.sealed === true) {
        return [...NO_TOOLS];
    }
    const asks = turn.approve === undefined ? [] : DEFAULT_MODE_ASKS;
    const own =
        turn.allowedTools === undefined
            ? [...sessionToolRules(mounts), ...asks]
            : allowlistRules(turn.allowedTools, mounts, { plan: turn.agent === "plan", asks, serverAsks: SERVER_PERMISSIONS });
    return [...own, ...personaRules(turn.persona)];
};
