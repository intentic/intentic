import { existsSync } from "node:fs";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { shellQuote, TMUX_RUN_BIN } from "../terminal/terminal-run.js";
import { AGENT_SESSION_PREFIX } from "../terminal/terminal-session.js";

// Rewrites every Bash tool command through bin/tmux-run (baked into the image), so the agent's shell
// commands run live-visible in `agent-<sdk session>` tmux sessions the terminal panel can attach to — the
// user watches (and can type into) the agent's terminals. Subagent Bash calls hit the same session-wide
// hook, so their commands land in the same session as extra windows.

// Off when the wrapper isn't baked in (local dev, tests) or the operator opts out.
export const tmuxRunEnabled = (): boolean => process.env["INTENTIC_AGENT_TMUX"] !== "0" && existsSync(TMUX_RUN_BIN);

// The tmux session the agent's Bash commands run in for one SDK session — the SAME derivation the hook routes
// commands through, so the emitted `terminal` frame and the live session can't drift. 8 chars of the SDK
// session UUID passes the session-name charset guard and groups a whole turn's commands (incl. subagents')
// under one terminal. undefined when the id sanitizes to empty (never a valid session name).
export const agentSessionName = (sessionId: string): string | undefined => {
    const id = sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "").slice(0, 8);
    return id === "" ? undefined : `${AGENT_SESSION_PREFIX}${id}`;
};

// tmux window name from the Bash tool's `description`, so the session's window list reads meaningfully.
// Same safe charset as session names (it lands in the rewritten shell line unquoted).
const windowSlug = (description: unknown): string => {
    if (typeof description !== "string") {
        return "run";
    }
    const slug = description
        .toLowerCase()
        .replaceAll(/[^a-z0-9_-]+/g, "-")
        .replaceAll(/^-+|-+$/g, "")
        .slice(0, 24);
    return slug === "" ? "run" : slug;
};

// When filterBackend is "rtk", the command is prefixed with `rtk ` before it's wrapped (rtk's own Claude Code
// hook convention: it recognizes and compresses the leading command, and passes through what it doesn't). The
// native output filter is turned off for this backend (cleanerEnv sets INTENTIC_RUN_FILTER=0), so rtk owns the
// compression and tmux-run just tees rtk's already-compact output. "native"/undefined keeps today's path.
export const bashTmuxHooks = (filterBackend?: "native" | "rtk"): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
    PreToolUse: [
        {
            matcher: "Bash",
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== "PreToolUse") {
                        return {};
                    }
                    const tool = input.tool_input as { command?: unknown; description?: unknown };
                    if (typeof tool.command !== "string" || tool.command.startsWith(TMUX_RUN_BIN)) {
                        return {};
                    }
                    const session = agentSessionName(input.session_id);
                    if (session === undefined) {
                        return {};
                    }
                    const inner = filterBackend === "rtk" ? `rtk ${tool.command}` : tool.command;
                    return {
                        hookSpecificOutput: {
                            hookEventName: "PreToolUse",
                            updatedInput: {
                                ...(tool as Record<string, unknown>),
                                command: `${TMUX_RUN_BIN} ${session} ${shellQuote(inner)} ${windowSlug(tool.description)}`,
                            },
                        },
                    };
                },
            ],
        },
    ],
});
