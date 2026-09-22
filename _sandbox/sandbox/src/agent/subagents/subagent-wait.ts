import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { sdk } from "../../runtimes/claude/claude-sdk.js";
import { AgentHarnessSchema, AgentProviderSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import type { ChildSupervisor } from "./children.js";
import type { SubagentWaitUntil } from "./subagents.js";
import { waitForWork, workWaitAnswer } from "./work-wait.js";

// A tool, not a CLI: a blocking shell command would hit the soft-timeout and become the polling it replaces.

// Long enough for a real run, short enough to return if forgotten; a longer wait means calling again.
const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 1800;

export interface SubagentWaitDeps {
    // The conversation whose children this turn may wait on; a parent supervises only its own.
    readonly conversationId: string | undefined;
    // The turn's own abort; a parked wait settles when the turn is stopped.
    readonly signal: AbortSignal;
    // The child-agent engine (spawn, steer, answer); absent means the spawn/send/answer tools are not offered.
    readonly children?: ChildSupervisor;
}

const UNTIL = z.enum(["blocked", "finished"]);

const NOTHING_TO_WAIT_FOR =
    "Nothing to wait for: no child or background command of this conversation is still running under that id, or its ending was already reported.";

// The tool's whole answer as one JSON text block, so the model can branch on `outcome` without parsing prose.
const answer = (payload: Record<string, unknown>): { content: [{ type: "text"; text: string }] } => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
});

export const subagentWaitServer = (deps: SubagentWaitDeps): McpSdkServerConfigWithInstance =>
    sdk().createSdkMcpServer({
        name: "subagents",
        // In the prompt, not behind tool search: a supervising parent reaches for this mid-flight.
        alwaysLoad: true,
        tools: [
            ...(deps.children === undefined
                ? []
                : [
                      sdk().tool(
                          "providers",
                          "What a child agent could be started on right now: every provider this sandbox has connected, its models, " +
                              "and how much allowance each still has. Call it before spawn when you do not already know which model " +
                              "you want — spawn requires a provider and a model, and models whose every connected account is at its " +
                              "cap are left out of this list, so what it shows is what can actually run.",
                          {},
                          async () => {
                              const children = deps.children;
                              if (children === undefined) {
                                  return answer({ ok: false, message: "This turn cannot spawn agents." });
                              }
                              return answer({ ok: true, providers: await children.providers() });
                          },
                      ),
                      sdk().tool(
                          "spawn",
                          "Start a full agent on any connected provider (claude, codex, grok, kimi, gemini, cursor — e.g. Cursor's " +
                              "Composer models) to work on a task of its own. It runs as a separate conversation in its own isolated " +
                              "worktree, visible on the board, and keeps working after your turn ends; its finished work lands the way " +
                              "any agent's does. Returns the child's id immediately: supervise it with the wait tool (target: that id), " +
                              "which returns when it is blocked on input or finished, with its report. If your turn ends first, its " +
                              "report wakes this conversation when it finishes. Give it a self-contained prompt " +
                              "with every path, requirement, and constraint — it sees none of this conversation. You must name the " +
                              "provider AND the model: this spends a real allowance and nothing is chosen for you. Call the providers " +
                              "tool for what is connected and what still has room. A provider nobody has connected fails with the " +
                              "words to say so.",
                          {
                              prompt: z.string().min(1).describe("The child's whole task, self-contained."),
                              description: z.string().max(200).optional().describe("One line naming the task, for the board and the roster."),
                              provider: AgentProviderSchema.describe("Which provider serves it. Required: see the providers tool for what is connected."),
                              model: z
                                  .string()
                                  .min(1)
                                  .describe(
                                      "Which of its models, e.g. composer-2.5 on cursor. Required, and it must be one that provider serves: " +
                                          "a model name only means anything to the provider that vends it.",
                                  ),
                              harness: AgentHarnessSchema.optional().describe("Which agentic loop runs it. Leave it out for the provider's own."),
                              effort: z.string().optional().describe("How hard it should think, where the provider offers a choice."),
                              on: z
                                  .string()
                                  .optional()
                                  .describe(
                                      'Which machine runs it: a runner\'s name, or "here" to keep it in this sandbox. Leave it out and the fleet ' +
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
                                  provider: args.provider,
                                  model: args.model,
                                  ...(args.description !== undefined ? { description: args.description } : {}),
                                  ...(args.harness !== undefined ? { harness: args.harness } : {}),
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
                      sdk().tool(
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
                      sdk().tool(
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
            sdk().tool(
                "wait",
                "Wait until work you started here needs you: an agent you started, or a command you ran with " +
                    "run_in_background. Blocks until the target is blocked on input (a question or permission), or " +
                    "finishes, whichever comes first. For an agent it returns its status, its last report, and " +
                    "`verification` — whether anything actually checked the work that report describes (`verified` / " +
                    "`unproven` / `failing` / `no-code`, with the check that spoke). Read it before you build on what it " +
                    "says: an agent's own account of its work is a claim, not a result. For a command it returns the " +
                    "exit code, the tail of its output and the file holding all of it. Target an Agent-tool child by its " +
                    "spawning tool call id, a spawned agent by the id the spawn tool returned, a background command by " +
                    'the ID its Bash call returned, or "any" for whichever of these moves first (each is reported once). ' +
                    "Use this instead of sleeping or polling in a loop. On timeout it returns the current state: call it " +
                    "again to keep waiting.",
                {
                    target: z.string().min(1).describe('The child\'s tool call id, a background command\'s ID, or "any"'),
                    until: z.array(UNTIL).min(1).optional().describe('Which states end the wait; default ["blocked","finished"]'),
                    timeoutSeconds: z.number().min(5).max(MAX_TIMEOUT_S).optional().describe(`Default ${DEFAULT_TIMEOUT_S}`),
                },
                async (args) => {
                    const until: readonly SubagentWaitUntil[] = args.until ?? ["blocked", "finished"];
                    const timeoutMs = Math.round((args.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000);
                    if (deps.conversationId === undefined) {
                        return answer({ outcome: "unknown-target", note: "This turn has no conversation, so it has no children to wait on." });
                    }
                    const result = await waitForWork(deps.conversationId, {
                        ...(args.target !== "any" ? { target: args.target } : {}),
                        until,
                        timeoutMs,
                        signal: deps.signal,
                    });
                    return answer({
                        ...workWaitAnswer(result, (childId) => deps.children?.pendingQuestion(childId)),
                        ...(result.outcome === "unknown-target" ? { note: NOTHING_TO_WAIT_FOR } : {}),
                    });
                },
            ),
        ],
    });
