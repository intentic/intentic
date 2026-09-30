import type { McpServerConfig as CursorMcpServer, SDKCustomTool, SDKJsonValue, ToolName } from "@cursor/sdk";
import type { AgentEvent, AskQuestion } from "@intentic/sandbox-contract";
import { z } from "zod";
import type { AgentRequest, TurnHooks, TurnTools } from "../../agent/providers/agent-request.js";
import { formatAnswers } from "../../agent/tools/question-answers.js";
import type { SubagentWaitUntil } from "../../agent/subagents/subagents.js";
import { workWaitAnswer } from "../../agent/subagents/work-wait.js";
import { spawnedNote } from "../../agent/subagents/children.js";
import { type CommandGuard, consultWith, JS_SUBJECT } from "../../guard/command-guard.js";
import { outsideSourceOf, sealResult } from "../../guard/outside-results.js";
import type { TurnTaint } from "../../guard/turn-taint.js";
import { JS_TIMEOUT_DEFAULT_S, JS_TIMEOUT_MAX_S } from "../../execution/js-runtime.js";
import { JS_TOOL_NAME, jsToolDescription, runJsTool } from "../../execution/js-tool.js";

// What the turn's gate answers with and what it marks, the two halves a tool needs to run a program safely. Carried
// together because a runtime that consults without marking would launder outside content past the judge.
export interface CursorGuard {
    readonly gate: CommandGuard;
    readonly taint: TurnTaint;
}

// Turn tools on Cursor's runtime, two seams: every remote MCP mount (the browser stack included, now routers behind the
// daemon's one MCP door) becomes an http server, and the daemon's own in-process tools become customTools. The second
// seam is unique here: a tool whose handler runs in the daemon can park on a person, unlike one inside a vendor's own loop.

// Cursor's own askQuestion can self-answer in a headless run (a fabricated "skipped by user"), so it's withheld
// (TOOLS_WITHHELD). This handler runs here and settles only on a real person or abort, same schema as the Claude path's
// ask.
const askTool = (request: AgentRequest, push: (event: AgentEvent) => void): SDKCustomTool => ({
    description:
        'Ask the user 1-4 clarifying multiple-choice questions and wait for their answers. Use this whenever you need the user to choose between options before proceeding. Each question has 2-4 options; do NOT add an "Other" option: a free-text choice is provided automatically. Set multiSelect when several options may be picked together.',
    // JSON Schema, not zod: Cursor takes the schema as data, same shape the Claude SDK's tool() compiles from zod.
    inputSchema: {
        type: "object",
        properties: {
            questions: {
                type: "array",
                minItems: 1,
                maxItems: 4,
                items: {
                    type: "object",
                    properties: {
                        question: { type: "string" },
                        header: { type: "string" },
                        multiSelect: { type: "boolean" },
                        options: {
                            type: "array",
                            minItems: 2,
                            maxItems: 4,
                            items: {
                                type: "object",
                                properties: { label: { type: "string" }, description: { type: "string" }, preview: { type: "string" } },
                                required: ["label", "description"],
                            },
                        },
                    },
                    required: ["question", "header", "multiSelect", "options"],
                },
            },
        },
        required: ["questions"],
    },
    execute: async (args) => {
        const questions = (args["questions"] ?? []) as AskQuestion[];
        if (questions.length === 0) {
            return "No questions were supplied, so nothing was asked.";
        }
        // Named with its conversation, like the Claude path: dismissing the card must name the turn it ends.
        const { id, wait } = request.hooks.cards.create(
            "question",
            { kind: "question", requestId: "", cancelled: true },
            request.spec.conversationId,
        );
        push({ kind: "question", requestId: id, questions });
        const { reply, resolved } = await wait(request.signal);
        // Picks belong in the frame log too, not just the result: what a replayed transcript freezes the card with.
        push(resolved);
        return formatAnswers(questions, reply);
    },
});

// Only askQuestion; task stays, a subagent the daemon can't see inside beats one removed.
export const TOOLS_WITHHELD: readonly ToolName[] = ["askQuestion"];

// Same supervision calls the Claude Code loop mounts as an SDK MCP server (agent/subagent-wait.ts), through Cursor's
// own seam. The gate arrives already set on the request, so children are indistinguishable across runtimes.
const spawnTool = (children: NonNullable<TurnHooks["children"]>): SDKCustomTool => ({
    description:
        "Spawn a subagent: a full agent on any connected provider (claude, codex, grok, kimi, gemini, cursor) to " +
        "work on a task of its own. It runs as a separate conversation in its own isolated worktree, cut from your own " +
        "current work, and keeps working after your turn ends. Its finished work comes back into your checkout, as an " +
        "in-process subagent's edits do; where it clashes with your edits it is held, and merge brings it in. " +
        "Returns the subagent's id " +
        "immediately: supervise it with the wait tool (target: that id); if your turn ends first, its report wakes " +
        "this conversation when it finishes. Give it a self-contained prompt with " +
        "every path, requirement, and constraint — it sees none of this conversation. You must name the provider " +
        "AND the model: this spends a real allowance and nothing is chosen for you. Call the providers tool for " +
        "what is connected and what still has room.",
    inputSchema: {
        type: "object",
        properties: {
            prompt: { type: "string", description: "The subagent's whole task, self-contained." },
            description: { type: "string", description: "One line naming the task, for the board and the roster." },
            provider: { type: "string", description: "Which provider serves it. Required: see the providers tool for what is connected." },
            model: {
                type: "string",
                description:
                    "Which of its models, e.g. composer-2.5 on cursor. Required, and it must be one that provider serves: a model name " +
                    "only means anything to the provider that vends it.",
            },
            effort: { type: "string", description: "How hard it should think, where the provider offers a choice." },
        },
        required: ["prompt", "provider", "model"],
    },
    execute: async (args) => {
        const text = (key: string): string | undefined => (typeof args[key] === "string" && args[key] !== "" ? (args[key] as string) : undefined);
        const [prompt, description, provider, model, effort] = [
            text("prompt"),
            text("description"),
            text("provider"),
            text("model"),
            text("effort"),
        ];
        if (prompt === undefined) {
            return JSON.stringify({ ok: false, message: "A subagent needs a task: pass `prompt`." });
        }
        // Refusal carries the catalogue too (children.routes.ts): finding what's reachable must not be a guess.
        if (provider === undefined || model === undefined) {
            return JSON.stringify({
                ok: false,
                message: "A spawn needs a provider and a model: this spends a real allowance and nothing is chosen for you.",
                providers: await children.providers(),
            });
        }
        const result = await children.spawn({
            prompt,
            provider,
            model,
            ...(description !== undefined ? { description } : {}),
            ...(effort !== undefined ? { effort } : {}),
        });
        return JSON.stringify(result.ok ? { ok: true, child: result.id, note: spawnedNote(result.id, result.note, result.held === true) } : result);
    },
});

// Catalogue as its own tool, beside spawn: a required field is only fair if its answer is one call away.
const providersTool = (children: NonNullable<TurnHooks["children"]>): SDKCustomTool => ({
    description:
        "What a subagent could be spawned on right now: every provider this sandbox has connected, its " +
        "models, and how much allowance each still has. Models whose every connected account is at its cap are " +
        "left out, so what this shows is what can actually run.",
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: async () => JSON.stringify({ ok: true, providers: await children.providers() }),
});

// Wait ceiling/default match the harness tool's; long enough for a real child, short enough within the turn.
const WAIT_DEFAULT_S = 600;
const WAIT_MAX_S = 1800;

const sendTool = (children: NonNullable<TurnHooks["children"]>): SDKCustomTool => ({
    description:
        "Steer or continue a subagent you spawned. A working one gets the message mid-turn (where its runtime " +
        "takes one); a finished one runs a follow-up turn on its own conversation, continuing its session, so " +
        "refinement costs a message rather than a fresh agent. Supervise the follow-up with the wait tool.",
    inputSchema: {
        type: "object",
        properties: {
            child: { type: "string", description: "The subagent's id, from spawn." },
            message: { type: "string", description: "What to tell it, self-contained." },
        },
        required: ["child", "message"],
    },
    execute: async (args) => {
        const child = typeof args["child"] === "string" ? args["child"] : "";
        const message = typeof args["message"] === "string" ? args["message"] : "";
        if (child === "" || message === "") {
            return JSON.stringify({ ok: false, message: "Pass the subagent's id and a message." });
        }
        return JSON.stringify(await children.send(child, message));
    },
});

const CancelArgsSchema = z.object({ child: z.string().min(1) });

const mergeTool = (children: NonNullable<TurnHooks["children"]>): SDKCustomTool => ({
    description:
        "Bring a subagent's finished work into your own checkout when its changes clashed with your edits, so they were " +
        "held on its branch (its report or the wait tool's `landing` says so). Writes them with conflict markers where " +
        "they clash, for you to resolve. Its work reaches your checkout by itself when nothing clashes.",
    inputSchema: {
        type: "object",
        properties: { child: { type: "string", description: "The subagent's id, from spawn." } },
        required: ["child"],
    },
    execute: async (args) => {
        const parsed = CancelArgsSchema.safeParse(args);
        if (!parsed.success) {
            return JSON.stringify({ ok: false, message: "Pass the subagent's id." });
        }
        return JSON.stringify(await children.merge(parsed.data.child));
    },
});

const cancelTool = (children: NonNullable<TurnHooks["children"]>): SDKCustomTool => ({
    description:
        "Stop a subagent you spawned: its running turn, a start still waiting for memory, or a re-run the sandbox booked " +
        "for it by itself after a spent allowance or a turn that stopped short (the wait tool shows that as status " +
        "`paused`). Use it when you will do the work another way, so the original never resumes and duplicates it.",
    inputSchema: {
        type: "object",
        properties: { child: { type: "string", description: "The subagent's id, from spawn." } },
        required: ["child"],
    },
    execute: async (args) => {
        const parsed = CancelArgsSchema.safeParse(args);
        if (!parsed.success) {
            return JSON.stringify({ ok: false, message: "Pass the subagent's id." });
        }
        return JSON.stringify(await children.cancel(parsed.data.child));
    },
});

const answerTool = (children: NonNullable<TurnHooks["children"]>): SDKCustomTool => ({
    description:
        "Answer a QUESTION a subagent you spawned is parked on (the wait tool reports blocked and carries the " +
        "question). Pass your picks keyed by the question's own text, values as chosen option labels or your own " +
        "words. Only questions: a permission hold or a plan approval is the owner's consent to give, and this " +
        "tool refuses those.",
    inputSchema: {
        type: "object",
        properties: {
            child: { type: "string", description: "The subagent's id, from spawn." },
            answers: {
                type: "object",
                additionalProperties: { type: "array", items: { type: "string" } },
                description: "Your picks, keyed by question text; each value is the chosen labels (or your own words).",
            },
        },
        required: ["child", "answers"],
    },
    execute: async (args) => {
        const child = typeof args["child"] === "string" ? args["child"] : "";
        const raw = args["answers"];
        if (child === "" || typeof raw !== "object" || raw === null) {
            return JSON.stringify({ ok: false, message: "Pass the subagent's id and your answers." });
        }
        const answers: Record<string, string[]> = {};
        for (const [question, picks] of Object.entries(raw)) {
            answers[question] = Array.isArray(picks) ? picks.filter((entry): entry is string => typeof entry === "string") : [String(picks)];
        }
        return JSON.stringify(await children.answer(child, answers));
    },
});

const waitTool = (request: AgentRequest, children: NonNullable<TurnHooks["children"]>): SDKCustomTool => ({
    description:
        "Wait until a subagent you started needs you. Blocks until the target is blocked on input or finishes, " +
        "whichever comes first, then returns its status and last report (whole, as `report`, where the summary cuts it). " +
        "A `paused` one has not finished: the sandbox runs it again by itself, and cancel stops that. " +
        'Target a subagent by its id, or "any" ' +
        "for whichever of this conversation's subagents moves first (each is reported once). On timeout it returns the current state: call " +
        "it again to keep waiting. It returns early, with outcome `message`, when something is said into your turn while it waits.",
    inputSchema: {
        type: "object",
        properties: {
            target: { type: "string", description: 'The subagent\'s id, or "any".' },
            until: { type: "array", items: { type: "string", enum: ["blocked", "finished"] }, description: 'Default ["blocked","finished"].' },
            timeoutSeconds: { type: "number", description: `Default ${WAIT_DEFAULT_S}, at most ${WAIT_MAX_S}.` },
        },
        required: ["target"],
    },
    execute: async (args) => {
        if (request.spec.conversationId === undefined) {
            return JSON.stringify({ outcome: "unknown-target", note: "This turn has no conversation, so it has no children to wait on." });
        }
        const target = typeof args["target"] === "string" ? args["target"] : "any";
        const until = (Array.isArray(args["until"]) ? args["until"] : []).filter(
            (entry): entry is SubagentWaitUntil => entry === "blocked" || entry === "finished",
        );
        const seconds = typeof args["timeoutSeconds"] === "number" ? Math.min(Math.max(args["timeoutSeconds"], 5), WAIT_MAX_S) : WAIT_DEFAULT_S;
        const result = await children.wait({
            ...(target !== "any" ? { target } : {}),
            until: until.length > 0 ? until : ["blocked", "finished"],
            timeoutMs: Math.round(seconds * 1000),
            signal: request.signal,
        });
        return JSON.stringify(
            workWaitAnswer(result, {
                pendingQuestion: (childId) => children.pendingQuestion(childId),
                report: (childId) => children.report(childId),
                landing: (childId) => children.landing(childId),
            }),
        );
    },
});

// The JS backend as Cursor's own tool rather than an MCP server, the same seam ask and the supervision set ride. Its
// description is jsToolDescription, so what the model is promised is what js-runtime enforces, on every runtime that
// mounts it.
//
// The gate is consulted HERE, and the result sealed HERE, not by hooks: Cursor's hook file only covers
// beforeShellExecution and its afterShellExecution reply is discarded, so a script arriving through a custom tool would
// otherwise both run with the owner's command rules unread and bring the web back into the turn unwrapped. Same
// subject, same consult and same envelope the Claude loop's PreToolUse and PostToolUse matchers raise, so one rule and
// one judge cover both.
const codeTool = (
    request: AgentRequest,
    plan: NonNullable<TurnTools["jsExecution"]>,
    guard: CursorGuard,
    push: (event: AgentEvent) => void,
): SDKCustomTool => ({
    description: jsToolDescription(plan),
    inputSchema: {
        type: "object",
        properties: {
            code: { type: "string", description: "The ES module to run. Top-level await allowed; print what you need back." },
            timeoutSeconds: {
                type: "number",
                minimum: 1,
                maximum: JS_TIMEOUT_MAX_S,
                description: `Seconds before the run is killed. Default ${JS_TIMEOUT_DEFAULT_S}, max ${JS_TIMEOUT_MAX_S}.`,
            },
        },
        required: ["code"],
    },
    execute: async (args) => {
        const code = typeof args["code"] === "string" ? args["code"] : "";
        if (code === "") {
            return "No code was supplied, so nothing ran.";
        }
        const verdict = await consultWith(guard.gate, code, JS_SUBJECT, push);
        if (!verdict.allow) {
            return verdict.reason;
        }
        const output = await runJsTool(
            {
                plan,
                placement: request.spec.isolation,
                signal: request.signal,
                ...(request.tools.secrets === undefined ? {} : { secrets: request.tools.secrets }),
            },
            { code, ...(typeof args["timeoutSeconds"] === "number" ? { timeoutSeconds: args["timeoutSeconds"] } : {}) },
        );
        // Read off the script, not the output: a program that reached the network brought back a stranger's words,
        // whatever they look like.
        const source = outsideSourceOf(JS_TOOL_NAME, { code });
        if (source === undefined) {
            return output;
        }
        guard.taint.mark(source);
        return sealResult(JS_TOOL_NAME, output, source) as string;
    },
});

// `ask` is mounted on every turn: an unattended turn's question waits for the owner like any other card. The
// supervision set isn't card-shaped and rides every turn too; a child settles on its own clock.
export const cursorCustomTools = (request: AgentRequest, guard: CursorGuard, push: (event: AgentEvent) => void): Record<string, SDKCustomTool> => ({
    ask: askTool(request, push),
    // Absent, not refused, when the persona's card withheld the backend: jsExecutionPlanOf answers undefined there.
    ...(request.tools.jsExecution === undefined ? {} : { code: codeTool(request, request.tools.jsExecution, guard, push) }),
    ...(request.hooks.children !== undefined
        ? {
              spawn: spawnTool(request.hooks.children),
              providers: providersTool(request.hooks.children),
              wait: waitTool(request, request.hooks.children),
              send: sendTool(request.hooks.children),
              answer: answerTool(request.hooks.children),
              cancel: cancelTool(request.hooks.children),
              merge: mergeTool(request.hooks.children),
          }
        : {}),
});

// Every remote mount as an http server, the same list every runtime projects. The daemon's in-process SDK servers have
// no Cursor projection: the gap behind mcp:"tools", not "full".
export const cursorMcpServers = (request: AgentRequest): Record<string, CursorMcpServer> =>
    Object.fromEntries(
        (request.tools.remote ?? []).map((tool) => [
            tool.name,
            { type: "http", url: tool.url, ...(tool.token !== undefined ? { headers: { Authorization: `Bearer ${tool.token}` } } : {}) } satisfies CursorMcpServer,
        ]),
    );

// Cursor's custom-tool results are JSON values; nothing here needs the richer content shape.
export type CursorToolResult = SDKJsonValue;
