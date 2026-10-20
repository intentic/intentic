import { HISTORY_ROOT } from "@intentic/constants";
import { join } from "node:path";
import { retainToolText, type McpOutputOptions } from "../../../guard/mcp-output.js";
import { spawnCatalogText } from "../spawn-catalog.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { sdk } from "../../../engines/claude-sdk.js";
import { type AgentHarness, AgentHarnessSchema, type AgentProvider, AgentProviderSchema } from "@intentic/sandbox-contract/schemas/agent";
import { harnessChoosable, loopsOf, PROVIDERS } from "@intentic/sandbox-contract/models/agent-catalog";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import { type ChildRehome, type ChildSpawnSpec, type ChildSupervisor, spawnedNote } from "../children.js";
import type { ChildResultDoor } from "../child-records.js";
import { ResultSchemaSchema, ResultValueSchema, resultValidator } from "../child-result.js";
import { HALF_A_MOVE } from "../child-words.js";
import type { SubagentWaitUntil } from "../subagents.js";
import { type ChildrenWaitAnswer, childrenWaitAnswer, waitForChildren, waitForWork, workWaitAnswer } from "./work-wait.js";
import { opt } from "../../../opt.js";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { keepBackgroundJob, type KeepOutcome } from "../../tools/jobs/background-jobs.js";

// A tool, not a CLI: a blocking shell command would hit the soft-timeout and become the polling it replaces.

// Long enough for a real run, short enough to return if forgotten; a longer wait means calling again.
const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 1800;

// One tool as the SDK's server takes it.
export type ServerTool = NonNullable<Parameters<ReturnType<typeof sdk>["createSdkMcpServer"]>[0]["tools"]>[number];

export interface SubagentWaitDeps {
    // The conversation whose children this turn may wait on; a parent supervises only its own.
    readonly conversationId: string | undefined;
    // Where its children and background commands are held, and the queue a report a wait took is withdrawn from.
    readonly conversations: Pick<ConversationActors, "holdings" | "queued" | "send">;
    // The turn's own abort; a parked wait settles when the turn is stopped.
    readonly signal: AbortSignal;
    // The child-agent engine (spawn, steer, answer); absent means the spawn/send/answer tools are not offered.
    readonly children?: ChildSupervisor;
    // Where this turn hands its result, when it is a spawned child its parent gave a result schema (children.ts
    // childResultDoor); absent for every other turn, which gets no `result` tool.
    readonly result?: ChildResultDoor;
    // More tools for the same server, built by whoever mounts it: the workflow tools over this turn's runs
    // (agent/subagents/workflows/script-run-tools.ts), which reach the child engine from above, so this server never names them.
    readonly extraTools?: readonly ServerTool[];
    readonly logsDir?: string;
}

// Bound each report before JSON serialization, preserving the surrounding wait status and verification fields.
export const boundChildReport = (report: string | undefined, options: McpOutputOptions): string | undefined => {
    if (report === undefined || report.length <= 12_000) {
        return report;
    }
    const path = retainToolText(report, options);
    if (path === undefined) {
        return report;
    }
    return `${report.slice(0, 4_000)}\n… report middle omitted …\n${report.slice(-7_000)}\n--- ${report.length - 11_000} chars cut · full: retrieve-output ${path} [pattern]`;
};

const reportOf = (deps: SubagentWaitDeps, childId: string): string | undefined =>
    boundChildReport(deps.children?.report(childId), { logsDir: deps.logsDir ?? join(HISTORY_ROOT, "logs") });

const UNTIL = z.enum(["blocked", "finished"]);

// Every provider offering more than one loop, said with its loops by name, so the parameter's own words say which values
// mean anything for which provider; derived from the provider table, so a new pair reaches this text by itself.
const CHOOSABLE_LOOPS = PROVIDERS.filter((provider) => harnessChoosable(provider.value))
    .map((provider) => `${provider.value}: ${loopsOf(provider.value).join(` or `)}`)
    .join(`; `);
const SPAWN_HARNESS_WORDS = `Which agentic loop runs it. Leave it out for the provider's own. ${CHOOSABLE_LOOPS} (the first is its own). A loop the provider doesn't offer runs its own instead.`;

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

// What the send tool tells the model, kept outside the server it is mounted on.
const SEND_WORDS =
    "Steer or continue a subagent you spawned. A working one gets the message mid-turn (where its runtime " +
    "takes one); a finished one runs a follow-up turn on its own conversation, continuing its session, " +
    "so refinement costs a message rather than a fresh agent. Supervise the follow-up with wait. A message " +
    "the owner must allow returns at once and goes when they do; you are told if it does not. Name a provider " +
    "and model to move a finished, failed or paused one there: it carries on in its own worktree with its work so far, " +
    "in a fresh session seeded from its own record, and a re-run booked where it was is dropped. That is the way on " +
    "for a child refused on its provider: a fresh spawn would start over.";

// A move with a send: the provider and model its next turn runs on, the loop and effort only where named.
const REHOME_FIELDS = {
    provider: AgentProviderSchema.optional().describe("Move it to this provider for this turn; needs `model`."),
    model: z.string().min(1).optional().describe("The model on that provider; needs `provider`."),
    harness: AgentHarnessSchema.optional().describe(SPAWN_HARNESS_WORDS),
    effort: z.string().optional().describe("How hard it should think there, where that provider offers a choice."),
};

const rehomeOf = (args: {
    readonly provider?: AgentProvider | undefined;
    readonly model?: string | undefined;
    readonly harness?: AgentHarness | undefined;
    readonly effort?: string | undefined;
}): ChildRehome | undefined =>
    args.provider === undefined || args.model === undefined
        ? undefined
        : { provider: args.provider, model: args.model, ...opt("harness", args.harness), ...opt("effort", args.effort) };

// Where a spawned child goes by itself when its provider refuses it outright or its allowance is far from reopening.
const FALLBACKS_FIELD = z
    .array(z.object({ provider: AgentProviderSchema, model: z.string().min(1) }))
    .max(4)
    .optional()
    .describe(
        "Where it goes by itself, in this order, when its provider refuses it in a way no wait soon answers (an account refused outright, a model off the plan, a spent allowance with no reset or one hours away): it moves to the next one the records do not call spent, in its own worktree, and you are told.",
    );

// A result schema a parent names at spawn: any JSON object here, held to the result subset by the spawn itself
// (child-result.ts resultSchemaFault), where the refusal can say which keyword is out of bounds.
const SCHEMA_FIELD = z
    .looseObject({})
    .optional()
    .describe(
        "A JSON Schema for a structured result you want back besides its report. With it, the subagent gets a `result` tool " +
            "taking exactly that shape, which refuses a value that does not match, and wait hands the value over as `result` " +
            "(or says why there is none as `resultError`). It may use type, properties, required, items, enum, const, " +
            "description, title, minimum, maximum, exclusiveMinimum, exclusiveMaximum, minLength, maxLength, minItems, maxItems, " +
            "default and additionalProperties (true or false).",
    );

// The child's own door for its result: the input is the parent's schema itself, so its runtime shows the model the exact
// shape and the SDK refuses a value that does not match before the handler runs, said back to the model to fix.
const resultTool = (door: ChildResultDoor) =>
    sdk().tool(
        "result",
        "Hand your parent the structured result it asked for in your task, as `value` matching the schema it gave. Call it " +
            "once the work is done; a value that does not match is refused with why, so fix it and call again. Calling it " +
            "again replaces the value. Then end your turn with a short report.",
        { value: resultValidator(door.schema) },
        async (args) => {
            const parsed = ResultValueSchema.safeParse(args.value);
            if (!parsed.success) {
                return answer({ ok: false, message: "The value must be JSON." });
            }
            const taken = door.take(parsed.data);
            return answer(
                "value" in taken
                    ? { ok: true, note: "Recorded: your parent receives this value with your report. End your turn with a short report." }
                    : { ok: false, message: `Not recorded, it does not match the schema: ${taken.error}` },
            );
        },
        { annotations: toolAnnotations("write") },
    );

// The spawn tool's arguments.
const SPAWN_FIELDS = {
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
    harness: AgentHarnessSchema.optional().describe(SPAWN_HARNESS_WORDS),
    effort: z.string().optional().describe("How hard it should think, where the provider offers a choice."),
    on: z
        .string()
        .optional()
        .describe(
            'Which machine runs it: a runner\'s name, or "here" to keep it in this sandbox. Leave it out and the fleet ' +
                "decides, which is what spreads a fan-out over every machine you have connected.",
        ),
    fallbacks: FALLBACKS_FIELD,
    schema: SCHEMA_FIELD,
};
type SpawnArgs = z.infer<z.ZodObject<typeof SPAWN_FIELDS>>;

// The spawn the tool's arguments ask for, each knob only where named, or why its result schema is no JSON object.
const spawnAsked = (args: SpawnArgs): ChildSpawnSpec | { readonly refused: string } => {
    const schema = args.schema === undefined ? undefined : ResultSchemaSchema.safeParse(args.schema);
    if (schema !== undefined && !schema.success) {
        return { refused: "The result schema must be a JSON object: a JSON Schema describing the value you want back." };
    }
    return {
        prompt: args.prompt,
        provider: args.provider,
        model: args.model,
        ...opt("description", args.description),
        ...opt("harness", args.harness),
        ...opt("effort", args.effort),
        ...opt("on", args.on),
        ...opt("fallbacks", args.fallbacks),
        ...opt("result", schema?.data === undefined ? undefined : { schema: schema.data }),
    };
};

// What the wait tool tells the model it does, in one place outside the server it is mounted on.
const WAIT_WORDS =
    "Wait until work you started here needs you: a subagent you started, or a command you ran with " +
    "run_in_background. Blocks until the target is blocked on input (a question or permission), or " +
    "finishes, whichever comes first. For an agent it returns its status, its last report (capped at 12k characters with a full-file retrieval handle, as " +
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
    'the ID its Bash call returned, or "any" for whichever of these moves first (each is reported once; ' +
    "a background command counts only while a child is still running, so with no child left it answers at once and " +
    "lists the commands still running in `running`). " +
    "An agent `paused` has not finished: its turn stopped on a spent allowance or stopped short, the sandbox " +
    "runs it again by itself (its `error` says when), and its report comes after that; cancel it before " +
    "giving its task to another agent. " +
    'To wait on several children as one, name them in `targets` (or pass target "all" for every child ' +
    "still running): the wait comes back early only for trouble (a child blocked on a question, paused, " +
    "failed or stopped, as `agent`), and otherwise once every one has finished, each in `agents` with its " +
    "whole report, so a fan-out costs you one wake instead of one per child. " +
    "Use this instead of sleeping or polling in a loop. On timeout it returns the current state: call it " +
    "again to keep waiting. It also returns early, with outcome `message`, when something is said into your " +
    "turn while it waits (the owner, a watch, a subagent's report, a land of a subagent's work), so you read it " +
    "now rather than when the wait runs out.";

// A wait on several children as one (work-wait.ts waitForChildren): `targets`, or every live child for "all".
const waitOnMany = async (
    deps: SubagentWaitDeps,
    conversationId: string,
    targets: readonly string[] | undefined,
    timeoutMs: number,
): Promise<ChildrenWaitAnswer> => {
    const many = await waitForChildren(deps.conversations, conversationId, { ...opt("targets", targets), timeoutMs, signal: deps.signal });
    const said = childrenWaitAnswer(many, {
        pendingQuestion: (childId) => deps.children?.pendingQuestion(childId),
        report: (childId) => reportOf(deps, childId),
        landing: (childId) => deps.children?.landing(childId),
        result: (childId) => deps.children?.result(childId),
    });
    return many.outcome === "unknown-target" ? { ...said, note: NOTHING_TO_WAIT_FOR } : said;
};

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
                              "how much allowance each still has and in which pool (a five-hour window, a weekly one), how many of " +
                              "this sandbox's agents already run on each provider, and when each last ran out, how far into its " +
                              "window and under how many agents. Call it before spawn when you do not already know which model you " +
                              "want, and before a fan-out: spawn requires a provider and a model, models the records call spent are " +
                              "left out of this list, and a spawn naming one is refused before it takes a seat. What it shows is what " +
                              "is not known to be spent, which is weaker than a promise: a provider publishing no allowance reads as " +
                              "not metered, and the only thing that ever measures one of those is a turn it has already refused. Each " +
                              "figure is one account's, and subagents started together draw on it together: N children spend it " +
                              "about N times as fast as one, so read the last run-out before starting several on one provider.",
                          {},
                          async () => {
                              const children = deps.children;
                              if (children === undefined) {
                                  return answer({ ok: false, message: "This turn cannot spawn agents." });
                              }
                              // The listing as the CLI prints it: what each model has left and in which pool, how many
                              // agents already run on each provider, when each last ran out. Raw rows once went out
                              // here instead, and every word added to the listing for a fan-out never reached the model.
                              return { content: [{ type: "text" as const, text: spawnCatalogText(await children.providers()) }] };
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
                          SPAWN_FIELDS,
                          async (args) => {
                              const children = deps.children;
                              if (children === undefined) {
                                  return answer({ ok: false, message: "This turn cannot spawn agents." });
                              }
                              const asked = spawnAsked(args);
                              if ("refused" in asked) {
                                  return answer({ ok: false, message: asked.refused });
                              }
                              const result = await children.spawn(asked);
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
                          SEND_WORDS,
                          {
                              child: z.string().min(1).describe("The subagent's id, from spawn."),
                              message: z.string().min(1).describe("What to tell it, self-contained."),
                              ...REHOME_FIELDS,
                          },
                          async (args) => {
                              const children = deps.children;
                              if (children === undefined) {
                                  return answer({ ok: false, message: "This turn cannot supervise agents." });
                              }
                              const rehome = rehomeOf(args);
                              if (rehome === undefined && [args.provider, args.model, args.harness, args.effort].some((part) => part !== undefined)) {
                                  return answer(HALF_A_MOVE);
                              }
                              return answer(await children.send(args.child, args.message, rehome));
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
                WAIT_WORDS,
                {
                    target: z
                        .string()
                        .min(1)
                        .describe(
                            'The subagent\'s id (its call\'s, or the one spawn returned), a background command\'s ID, "any", or "all" for every child still running',
                        ),
                    targets: z
                        .array(z.string().min(1))
                        .min(1)
                        .optional()
                        .describe("Several children's ids, waited on as one; `target` is then ignored. Returns early only for trouble."),
                    until: z.array(UNTIL).min(1).optional().describe('Which states end the wait; default ["blocked","finished"]'),
                    timeoutSeconds: z.number().min(5).max(MAX_TIMEOUT_S).optional().describe(`Default ${DEFAULT_TIMEOUT_S}`),
                },
                async (args) => {
                    const until: readonly SubagentWaitUntil[] = args.until ?? ["blocked", "finished"];
                    const timeoutMs = Math.round((args.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000);
                    if (deps.conversationId === undefined) {
                        return answer({ outcome: "unknown-target", note: "This turn has no conversation, so it has no children to wait on." });
                    }
                    if (args.targets !== undefined || args.target === "all") {
                        return answer({ ...(await waitOnMany(deps, deps.conversationId, args.targets, timeoutMs)) });
                    }
                    const result = await waitForWork(deps.conversations, deps.conversationId, {
                        ...(args.target !== "any" ? { target: args.target } : {}),
                        until,
                        timeoutMs,
                        signal: deps.signal,
                    });
                    // The shared answer's own note, where it has one, says more than the generic one.
                    return answer({
                        ...(result.outcome === "unknown-target" ? { note: NOTHING_TO_WAIT_FOR } : {}),
                        ...workWaitAnswer(result, {
                            pendingQuestion: (childId) => deps.children?.pendingQuestion(childId),
                            report: (childId) => reportOf(deps, childId),
                            landing: (childId) => deps.children?.landing(childId),
                            result: (childId) => deps.children?.result(childId),
                        }),
                    });
                },
                // Moves only which endings this conversation was told, marked as a wait settles, so parallel waits never share one.
                { annotations: toolAnnotations("read") },
            ),
            ...(deps.result === undefined ? [] : [resultTool(deps.result)]),
            ...(deps.extraTools ?? []),
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
