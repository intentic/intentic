import { existsSync } from "node:fs";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { type IsolationAnchor, nsenterPrefix } from "../agents/isolation.js";
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

// Env var NAMES forwarded onto each command's tmux window (`-e NAME` — tmux-run resolves the value from its
// own environment, which the SDK subprocess passes down fresh each turn). The pane's shell otherwise inherits
// the tmux SERVER's env snapshot, so per-turn capability credentials would be missing or stale there; the
// value itself never appears in the rewritten command text, transcript, or pane logs. Only valid identifiers
// survive: these land unquoted in the shell line every Bash command flows through. A capability REMOVED after
// the server captured its var stays in the server env — forwarding only overrides per-window.
const envKeyFlags = (envKeys: readonly string[]): string =>
    [...envKeys]
        .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        .toSorted()
        .map((key) => `-e ${key} `)
        .join("");

// When filterBackend is "rtk", the command is prefixed with `rtk ` before it's wrapped (rtk's own Claude Code
// hook convention: it recognizes and compresses the leading command, and passes through what it doesn't). The
// native output filter is turned off for this backend (cleanerEnv sets INTENTIC_RUN_FILTER=0), so rtk owns the
// compression and tmux-run just tees rtk's already-compact output. "native"/undefined keeps today's path.
export const bashTmuxHooks = (
    filterBackend?: "native" | "rtk",
    envKeys: readonly string[] = [],
    // An isolated turn's Bash must run in the SAME namespace as its Edit/Write, or the two tools disagree
    // about what /work is — the agent edits its worktree and `sed -i` on the same path rewrites the shared
    // tree. A pane is forked by the tmux SERVER, which lives in the daemon's namespace, so the pane's own
    // command line is the only place that can join: nsenter wraps the command INSIDE the window, leaving the
    // server, its socket, and the terminals panel's list/attach exactly as they are.
    isolation?: IsolationAnchor,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    const envFlags = envKeyFlags(envKeys);
    return {
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
                        const wrapped = filterBackend === "rtk" ? `rtk ${tool.command}` : tool.command;
                        // The namespace hop goes OUTSIDE the rtk prefix and inside the tmux wrapper: rtk is
                        // the agent's own command line and belongs in the namespace with it, while tmux-run
                        // itself must stay out here where the server and the pane logs are.
                        const inner = isolation !== undefined ? `${nsenterPrefix(isolation.pid, isolation.cwd)}bash -c ${shellQuote(wrapped)}` : wrapped;
                        return {
                            hookSpecificOutput: {
                                hookEventName: "PreToolUse",
                                updatedInput: {
                                    ...(tool as Record<string, unknown>),
                                    command: `${TMUX_RUN_BIN} ${envFlags}${session} ${shellQuote(inner)} ${windowSlug(tool.description)}`,
                                },
                            },
                        };
                    },
                ],
            },
        ],
    };
};
