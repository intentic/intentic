import { createSdkMcpServer, type McpSdkServerConfigWithInstance, tool } from "@anthropic-ai/claude-agent-sdk";
import { AgentHarnessSchema, AgentProviderSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import type { ChildSupervisor } from "../children/children.js";
import { waitForSubagent, type SubagentWaitUntil } from "./subagents.js";

/* "WAIT UNTIL THAT AGENT NEEDS ME", the tool a supervising turn parks on instead of polling — and, beside it,
 * "START ONE", the `spawn` tool, which is what makes the pair a supervision surface rather than a watch: a turn
 * starts a full agent on ANY connected provider (children/children.ts) and parks here until it needs input or
 * reports. Spawn is offered only where the route injected its engine; wait is always offered.
 *
 * A parent that starts other agents, a spawned child on another provider, an Agent-tool child, used to have
 * two ways to follow them: burn turns polling on a timer, or walk away and be told only by the exit. Both miss
 * the one state that matters most, a child sitting on a question, and the polling version spends tokens to
 * miss it. This tool is the third way: one call that returns when the child needs input or finishes, fed by
 * the same signals the roster reads (the child service's own calls, the SDK's task stream), so the parent
 * sleeps for free and wakes exactly once, with the child's own report in hand.
 *
 * ONLY THIS TURN'S OWN CHILDREN, named by the spawning tool call's id (an SDK child) or the spawn tool's
 * returned id, the same key the Subagents area uses. It once also took a sibling fleet agent's conversation
 * id, which cost a second waiting engine with its own idea of what "blocked" means and bought a supervision
 * pattern nobody was asking for. Waiting on your own children is the whole of the problem this solves.
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
    /* The child-agent supervision engine (children/children.ts): spawn on any connected provider, steer or
     * follow-up a child, answer its questions. Injected by the route that owns the turn generator
     * (agent.routes.ts), the same door every other spawned turn goes through; absent for a conversationless
     * turn (a child needs a parent to file under) and for focused callers with no route behind them, and the
     * spawn/send/answer tools are then simply not offered. */
    readonly children?: ChildSupervisor;
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
            ...(deps.children === undefined
                ? []
                : [
                      tool(
                          "spawn",
                          "Start a full agent on any connected provider (claude, codex, grok, kimi, gemini, cursor — e.g. Cursor's " +
                              "Composer models) to work on a task of its own. It runs as a separate conversation in its own isolated " +
                              "worktree, visible on the board, and keeps working after your turn ends; its finished work lands the way " +
                              "any agent's does. Returns the child's id immediately: supervise it with the wait tool (target: that id), " +
                              "which returns when it is blocked on input or finished, with its report. Give it a self-contained prompt " +
                              "with every path, requirement, and constraint — it sees none of this conversation. A provider nobody has " +
                              "connected fails with the words to say so.",
                          {
                              prompt: z.string().min(1).describe("The child's whole task, self-contained."),
                              description: z.string().max(200).optional().describe("One line naming the task, for the board and the roster."),
                              provider: AgentProviderSchema.optional().describe("Which provider serves it. Leave it out for Claude."),
                              harness: AgentHarnessSchema.optional().describe("Which agentic loop runs it. Leave it out for the provider's own."),
                              model: z.string().optional().describe("Which model, e.g. composer-2.5 on cursor. Leave it out for the provider's default."),
                              effort: z.string().optional().describe("How hard it should think, where the provider offers a choice."),
                              on: z
                                  .string()
                                  .optional()
                                  .describe(
                                      "Which machine runs it: a runner's name, or \"here\" to keep it in this sandbox. Leave it out and the fleet " +
                                          "decides, which is what spreads a fan-out over every machine you have connected.",
                                  ),
                          },
                          async (args) => {
                              const children = deps.children;
                              if (children === undefined) {
                                  return answer({ ok: false, message: "This turn cannot spawn agents." });
                              }
                              const result = await children.spawn({
                                  prompt: args.prompt,
                                  ...(args.description !== undefined ? { description: args.description } : {}),
                                  ...(args.provider !== undefined ? { provider: args.provider } : {}),
                                  ...(args.harness !== undefined ? { harness: args.harness } : {}),
                                  ...(args.model !== undefined ? { model: args.model } : {}),
                                  ...(args.effort !== undefined ? { effort: args.effort } : {}),
                                  ...(args.on !== undefined ? { on: args.on } : {}),
                              });
                              return answer(
                                  result.ok
                                      ? { ok: true, child: result.id, note: `Running. Supervise it with wait(target: "${result.id}").` }
                                      : { ok: false, message: result.message },
                              );
                          },
                      ),
                      tool(
                          "send",
                          "Steer or continue an agent you started. A working child gets the message mid-turn (where its runtime " +
                              "takes one); a finished child runs a follow-up turn on its own conversation, continuing its session, " +
                              "so refinement costs a message rather than a fresh agent. Supervise the follow-up with wait.",
                          {
                              child: z.string().min(1).describe("The child's id, from spawn."),
                              message: z.string().min(1).describe("What to tell it, self-contained."),
                          },
                          async (args) => {
                              const children = deps.children;
                              if (children === undefined) {
                                  return answer({ ok: false, message: "This turn cannot supervise agents." });
                              }
                              return answer(await children.send(args.child, args.message));
                          },
                      ),
                      tool(
                          "answer",
                          "Answer a QUESTION a child you started is parked on (wait reports blocked and carries the question). " +
                              "Pass your picks keyed by the question's own text, values as chosen option labels or your own words. " +
                              "Only questions: a permission hold or a plan approval is the owner's consent to give, and this tool " +
                              "refuses those.",
                          {
                              child: z.string().min(1).describe("The child's id, from spawn."),
                              answers: z
                                  .record(z.string(), z.array(z.string()))
                                  .describe("Your picks, keyed by question text; each value is the chosen labels (or your own words)."),
                          },
                          async (args) => {
                              const children = deps.children;
                              if (children === undefined) {
                                  return answer({ ok: false, message: "This turn cannot supervise agents." });
                              }
                              return answer(await children.answer(args.child, args.answers));
                          },
                      ),
                  ]),
            tool(
                "wait",
                "Wait until an agent you started needs you. Blocks until the target is blocked on input (a question or " +
                    "permission), or finishes, whichever comes first: then returns its status, its last report, and " +
                    "`verification` — whether anything actually checked the work that report describes (`verified` / " +
                    "`unproven` / `failing` / `no-code`, with the check that spoke). Read it before you build on what it " +
                    "says: an agent's own account of its work is a claim, not a result. Target an " +
                    "Agent-tool child by its spawning tool call id, a spawned agent by the id the " +
                    'spawn tool returned, or "any" for whichever of this ' +
                    "conversation's children moves first. Use this instead of sleeping or polling in a " +
                    "loop. On timeout it returns the current state: call it again to keep waiting.",
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
                    // A blocked child's whole question rides along, options included: the difference between
                    // a parent that can answer and one that can only report.
                    const question =
                        result.outcome === "blocked" && result.matched !== undefined
                            ? deps.children?.pendingQuestion(result.matched.id)
                            : undefined;
                    return answer({
                        outcome: result.outcome,
                        ...(result.matched !== undefined ? { agent: result.matched } : {}),
                        ...(question !== undefined ? { question } : {}),
                        ...(result.outcome === "unknown-target"
                            ? {
                                  note: "Nothing to wait for: no child of this conversation is still running, it never started, it has already finished, or it left the roster.",
                              }
                            : {}),
                    });
                },
            ),
        ],
    });
