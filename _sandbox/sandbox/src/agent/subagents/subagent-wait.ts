import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { sdk } from "../../engines/claude-sdk.js";
import { AgentHarnessSchema, AgentProviderSchema } from "@intentic/sandbox-contract";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import { type ChildSupervisor, spawnedNote } from "./children.js";
import type { SubagentWaitUntil } from "./subagents.js";
import { waitForWork, workWaitAnswer } from "./work-wait.js";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import { keepBackgroundJob, type KeepOutcome } from "../tools/jobs/background-jobs.js";

// A tool, not a CLI: a blocking shell command would hit the soft-timeout and become the polling it replaces.

// Long enough for a real run, short enough to return if forgotten; a longer wait means calling again.
const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 1800;

export interface SubagentWaitDeps {
    // The conversation whose children this turn may wait on; a parent supervises only its own.
    readonly conversationId: string | undefined;
    // Where its children and background commands are held, and the queue a report a wait took is withdrawn from.
    readonly conversations: Pick<ConversationActors, "holdings" | "queued" | "send">;
    // The turn's own abort; a parked wait settles when the turn is stopped.
    readonly signal: AbortSignal;
    // The child-agent engine (spawn, steer, answer); absent means the spawn/send/answer tools are not offered.
    readonly children?: ChildSupervisor;
}

const UNTIL = z.enum(["blocked", "finished"]);

const NOTHING_TO_WAIT_FOR =
    "Nothing to wait for: no subagent or background command of this conversation is still running under that id, or its ending was already reported.";

const KEEP_ANSWERS = {
    kept: "Kept: it keeps running for the person after your turn ends. Give them its address in your reply.",
    unknown: "No background command of this conversation has that ID.",
    ended: "That command has already exited, so there is nothing to keep running.",
    stopped: "That command is being stopped, so it cannot be kept. Start it again and keep the new one.",
} as const satisfies Record<KeepOutcome, string>;

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
                          "What a subagent could be spawned on right now: every provider this sandbox has connected, its models, " +
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
                          { annotations: toolAnnotations("read") },
                      ),
                      sdk().tool(
                          "spawn",
                          "Spawn a subagent: a full agent on any connected provider (claude, codex, grok, kimi, gemini, cursor — e.g. " +
                              "Cursor's Composer models) to work on a task of its own. It runs as a separate conversation in its own isolated " +
                              "worktree cut from your own current work, visible on the board, and keeps working after your turn ends. " +
                              "Its finished work comes back into your checkout, as an in-process subagent's edits do, and reaches the " +
                              "workspace with your land; where it clashes with your edits it is held, and merge brings it in. " +
                              "Returns the subagent's id immediately: supervise it with the wait tool (target: that id), " +
                              "which returns when it is blocked on input or finished, with its report. On a sandbox short of memory it " +
                              "holds as pending until there is room, and wait covers that too. A start the owner must allow also returns " +
                              "at once, held, and waits on their card the same way; you carry on meanwhile. If your turn ends first, its " +
                              "report wakes this conversation when it finishes, and a question it stops on wakes it to answer. Give it a self-contained prompt " +
                              "with every path, requirement, and constraint — it sees none of this conversation. You must name the " +
                              "provider AND the model: this spends a real allowance and nothing is chosen for you. Call the providers " +
                              "tool for what is connected and what still has room. A provider nobody has connected fails with the " +
                              "words to say so.",
                          {
                              prompt: z.string().min(1).describe("The subagent's whole task, self-contained."),
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
                                      ? { ok: true, child: result.id, note: spawnedNote(result.id, result.note, result.held === true) }
                                      : { ok: false, message: result.message },
                              );
                          },
                          // Commits a provider's allowance to a new agent, and nothing later gives it back.
                          { annotations: toolAnnotations("destructive") },
                      ),
                      sdk().tool(
                          "send",
                          "Steer or continue a subagent you spawned. A working one gets the message mid-turn (where its runtime " +
                              "takes one); a finished one runs a follow-up turn on its own conversation, continuing its session, " +
                              "so refinement costs a message rather than a fresh agent. Supervise the follow-up with wait. A message " +
                              "the owner must allow returns at once and goes when they do; you are told if it does not.",
                          {
                              child: z.string().min(1).describe("The subagent's id, from spawn."),
                              message: z.string().min(1).describe("What to tell it, self-contained."),
                          },
                          async (args) => {
                              const children = deps.children;
                              if (children === undefined) {
                                  return answer({ ok: false, message: "This turn cannot supervise agents." });
                              }
                              return answer(await children.send(args.child, args.message));
                          },
                          { annotations: toolAnnotations("write") },
                      ),
                      sdk().tool(
                          "cancel",
                          "Stop a subagent you spawned: its running turn, a start still waiting for memory, or a re-run the " +
                              "sandbox booked for it by itself after a spent allowance or a turn that stopped short (wait shows " +
                              "that as status `paused`). Use it when you will do the work another way, so the original never " +
                              "resumes and duplicates it. What it already wrote stays in its worktree, and a later send carries on " +
                              "from there. A start or message waiting on the owner's card is theirs to decline, not yours to withdraw.",
                          { child: z.string().min(1).describe("The subagent's id, from spawn.") },
                          async (args) => {
                              const children = deps.children;
                              if (children === undefined) {
                                  return answer({ ok: false, message: "This turn cannot supervise agents." });
                              }
                              return answer(await children.cancel(args.child));
                          },
                          // Ends work in flight, and nothing gives it back but a new message.
                          { annotations: toolAnnotations("destructive") },
                      ),
                      sdk().tool(
                          "answer",
                          "Answer a QUESTION a subagent you spawned is parked on (wait reports blocked and carries the question). " +
                              "Pass one entry per question: its own text, and your picks as chosen option labels or your own words. " +
                              "Only questions: a permission hold or a plan approval is the owner's consent to give, and this tool " +
                              "refuses those.",
                          {
                              child: z.string().min(1).describe("The subagent's id, from spawn."),
                              // Never z.record: the SDK's JSON-schema converter throws on one, emptying this server's tools/list.
                              answers: z
                                  .array(
                                      z.object({
                                          question: z.string().min(1).describe("The question's own text."),
                                          picks: z.array(z.string()).describe("The chosen option labels, or your own words."),
                                      }),
                                  )
                                  .describe("Your picks, one entry per question."),
                          },
                          async (args) => {
                              const children = deps.children;
                              if (children === undefined) {
                                  return answer({ ok: false, message: "This turn cannot supervise agents." });
                              }
                              const picks = Object.fromEntries(args.answers.map((entry) => [entry.question, entry.picks]));
                              return answer(await children.answer(args.child, picks));
                          },
                          { annotations: toolAnnotations("write") },
                      ),
                      sdk().tool(
                          "merge",
                          "Bring a subagent's finished work into your own checkout when its changes clashed with your edits, " +
                              "so they were held on its branch (its report or wait's `landing` says so). Writes them with " +
                              "conflict markers where they clash, for you to resolve, as you would merge a branch yourself. " +
                              "Its work reaches your checkout by itself when nothing clashes.",
                          { child: z.string().min(1).describe("The subagent's id, from spawn.") },
                          async (args) => {
                              const children = deps.children;
                              if (children === undefined) {
                                  return answer({ ok: false, message: "This turn cannot supervise agents." });
                              }
                              return answer(await children.merge(args.child));
                          },
                          { annotations: toolAnnotations("write") },
                      ),
                  ]),
            sdk().tool(
                "wait",
                "Wait until work you started here needs you: a subagent you started, or a command you ran with " +
                    "run_in_background. Blocks until the target is blocked on input (a question or permission), or " +
                    "finishes, whichever comes first. For an agent it returns its status, its last report (whole, as " +
                    "`report`, where the row's `summary` is only its head), and " +
                    "`verification` — whether anything actually checked the work that report describes (`verified` / " +
                    "`unproven` / `failing` / `no-code`, with the check that spoke). Read it before you build on what it " +
                    "says: an agent's own account of its work is a claim, not a result. A spawned one's `landing` says where " +
                    "its work went: into your checkout already, or held on its branch where it clashed with your edits " +
                    "(merge brings it in). For a command it returns the " +
                    "exit code, the tail of its output and the file holding all of it, and while it runs how long it has " +
                    "been quiet; a command sitting at a prompt (blocked reading its terminal, nothing moving) returns " +
                    "`blocked` with `waitingForInput`, since nothing in your turn can type into it and waiting again will " +
                    "not end it. Target a subagent your runtime's own " +
                    "tool started by that call's id, one you spawned by the id spawn returned, a background command by " +
                    'the ID its Bash call returned, or "any" for whichever of these moves first (each is reported once). ' +
                    "An agent `paused` has not finished: its turn stopped on a spent allowance or stopped short, the sandbox " +
                    "runs it again by itself (its `error` says when), and its report comes after that; cancel it before " +
                    "giving its task to another agent. " +
                    "Use this instead of sleeping or polling in a loop. On timeout it returns the current state: call it " +
                    "again to keep waiting. It also returns early, with outcome `message`, when something is said into your " +
                    "turn while it waits (the owner, a watch, a subagent's report, a land of a subagent's work), so you read it " +
                    "now rather than when the wait runs out.",
                {
                    target: z.string().min(1).describe('The subagent\'s id (its call\'s, or the one spawn returned), a background command\'s ID, or "any"'),
                    until: z.array(UNTIL).min(1).optional().describe('Which states end the wait; default ["blocked","finished"]'),
                    timeoutSeconds: z.number().min(5).max(MAX_TIMEOUT_S).optional().describe(`Default ${DEFAULT_TIMEOUT_S}`),
                },
                async (args) => {
                    const until: readonly SubagentWaitUntil[] = args.until ?? ["blocked", "finished"];
                    const timeoutMs = Math.round((args.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000);
                    if (deps.conversationId === undefined) {
                        return answer({ outcome: "unknown-target", note: "This turn has no conversation, so it has no children to wait on." });
                    }
                    const result = await waitForWork(deps.conversations, deps.conversationId, {
                        ...(args.target !== "any" ? { target: args.target } : {}),
                        until,
                        timeoutMs,
                        signal: deps.signal,
                    });
                    return answer({
                        ...workWaitAnswer(result, {
                            pendingQuestion: (childId) => deps.children?.pendingQuestion(childId),
                            report: (childId) => deps.children?.report(childId),
                            landing: (childId) => deps.children?.landing(childId),
                        }),
                        ...(result.outcome === "unknown-target" ? { note: NOTHING_TO_WAIT_FOR } : {}),
                    });
                },
                // Moves only which endings this conversation was told, marked as a wait settles, so parallel waits never share one.
                { annotations: toolAnnotations("read") },
            ),
            sdk().tool(
                "keep",
                "Leave a command you ran with run_in_background running for the person after your turn ends: a dev server " +
                    "or preview you started FOR them. This call is the only thing that keeps one: what your reply says " +
                    "decides nothing. A server you reached and did not keep is stopped when your turn ends; one you never " +
                    "reached is waited on like any command. A kept command wakes nobody when it exits and the person stops " +
                    "it from chat or Preview, so give them its address in your reply. Target it by the ID its Bash call returned.",
                {
                    target: z.string().min(1).describe("The background command's ID, as its Bash call returned it"),
                    reason: z.string().min(1).max(200).describe('What the person gets, e.g. "dev server for you at http://localhost:5173"'),
                },
                (args) => {
                    if (deps.conversationId === undefined) {
                        return Promise.resolve(answer({ ok: false, message: "This turn has no conversation, so nothing it starts outlives it." }));
                    }
                    const outcome = keepBackgroundJob(deps.conversations, deps.conversationId, args.target, args.reason);
                    return Promise.resolve(answer({ ok: outcome === "kept", message: KEEP_ANSWERS[outcome] }));
                },
                // Changes what the turn's ending does with the job, and nothing else.
                { annotations: toolAnnotations("write") },
            ),
        ],
    });
