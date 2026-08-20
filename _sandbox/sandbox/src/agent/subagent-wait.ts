import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { waitForSubagent, type SubagentWaitUntil } from "./subagents.js";

/* "WAIT UNTIL THAT AGENT NEEDS ME", the tool a supervising turn parks on instead of polling.
 *
 * A parent that starts other agents, a backgrounded `codex exec`, an Agent-tool child, used to have two ways
 * to follow them: burn turns re-reading a tmux tail on a timer, or walk away and be told only by the exit. Both
 * miss the one state that matters most, a child sitting on a question, and the polling version spends tokens to
 * miss it. This tool is the third way: one call that returns when the child needs input or finishes, fed by the
 * same signals the roster reads (the delegation hooks, the warm OpenCode server's events, the SDK's task
 * stream), so the parent sleeps for free and wakes exactly once, with the child's own report in hand.
 *
 * ONLY THIS TURN'S OWN CHILDREN, named by the spawning tool call's id, the id on the Bash/Agent card, and the
 * same key the Subagents area uses. It once also took a sibling fleet agent's conversation id, which cost a
 * second waiting engine with its own idea of what "blocked" means and bought a supervision pattern nobody was
 * asking for. Waiting on your own children is the whole of the problem this solves.
 *
 * An SDK MCP tool rather than a CLI on purpose: a blocking command under Bash would hit the shell's
 * soft-timeout detach and turn the wait into the very tail-polling it replaces, while a tool call parks
 * server-side exactly like a permission hold (guard/command-gate.ts) and settles with the turn's own abort. */

// The ceiling and default for one wait. The default is long enough for a real delegated run and short enough
// that a forgotten wait returns within the turn; the cap exists because a tool call is turn time, a parent
// that wants to wait longer calls again, which also gives steering a seam to land in.
const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 1800;

export interface SubagentWaitDeps {
    // The conversation whose children this turn may wait on, a parent only ever supervises its own.
    readonly conversationId: string | undefined;
    // The turn's own abort, so a parked wait settles when the turn is stopped under it.
    readonly signal: AbortSignal;
}

const UNTIL = z.enum(["blocked", "finished"]);

// The tool's whole answer as one JSON text block, structured enough for the model to branch on `outcome`
// without prose parsing.
const answer = (payload: Record<string, unknown>): { content: [{ type: "text"; text: string }] } => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
});

export const subagentWaitServer = (deps: SubagentWaitDeps): McpSdkServerConfigWithInstance =>
    createSdkMcpServer({
        name: "subagents",
        // In the prompt, not behind tool search: a supervising parent reaches for this mid-flight, and a tool
        // it has to go looking for is a tool it replaces with a sleep-and-poll loop.
        alwaysLoad: true,
        tools: [
            tool(
                "wait",
                "Wait until an agent you started needs you. Blocks until the target is blocked on input (a question or " +
                    "permission), or finishes, whichever comes first — then returns its status and last report. Target a " +
                    'delegated CLI run or Agent-tool child by its spawning tool call id, or "any" for whichever of this ' +
                    "conversation's children moves first. Use this instead of sleeping or re-reading terminal output in a " +
                    "loop. On timeout it returns the current state — call it again to keep waiting.",
                {
                    target: z.string().min(1).describe('The child\'s tool call id, or "any"'),
                    until: z.array(UNTIL).min(1).optional().describe('Which states end the wait; default ["blocked","finished"]'),
                    timeoutSeconds: z.number().min(5).max(MAX_TIMEOUT_S).optional().describe(`Default ${DEFAULT_TIMEOUT_S}`),
                },
                async (args) => {
                    const until: readonly SubagentWaitUntil[] = args.until ?? ["blocked", "finished"];
                    const timeoutMs = Math.round((args.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000);
                    if (deps.conversationId === undefined) {
                        return answer({ outcome: "unknown-target", note: "This turn has no conversation, so it has no children to wait on." });
                    }
                    const result = await waitForSubagent(deps.conversationId, {
                        ...(args.target !== "any" ? { target: args.target } : {}),
                        until,
                        timeoutMs,
                        signal: deps.signal,
                    });
                    return answer({
                        outcome: result.outcome,
                        ...(result.matched !== undefined ? { agent: result.matched } : {}),
                        ...(result.outcome === "unknown-target"
                            ? {
                                  note: "Nothing to wait for: no child of this conversation is still running — it never started, it has already finished, or it left the roster.",
                              }
                            : {}),
                    });
                },
            ),
        ],
    });
