import type { McpServerConfig as CursorMcpServer, SDKCustomTool, SDKJsonValue, ToolName } from "@cursor/sdk";
import type { AgentEvent, AskQuestion } from "@intentic/sandbox-contract";
import { createRequest } from "../../agent/tools/agent-requests.js";
import type { AgentRequest } from "../../agent/run/agent.js";
import { formatAnswers } from "../../agent/tools/question-answers.js";
import { waitForSubagent, type SubagentWaitUntil } from "../../agent/subagents/subagents.js";

// Turn tools on Cursor's runtime, three seams: remote MCP tools become http servers, the browser stack (already stdio
// process specs) becomes stdio servers, and the daemon's own in-process tools become customTools. The third seam is
// unique here: a tool whose handler runs in the daemon can park on a person, unlike one inside a vendor's own loop.

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
        const { id, wait } = createRequest("question", { kind: "question", requestId: "", cancelled: true }, request.conversationId);
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
const spawnTool = (children: NonNullable<AgentRequest["children"]>): SDKCustomTool => ({
    description:
        "Start a full agent on any connected provider (claude, codex, grok, kimi, gemini, cursor) to work on a " +
        "task of its own. It runs as a separate conversation in its own isolated worktree and keeps working " +
        "after your turn ends; its finished work lands the way any agent's does. Returns the child's id " +
        "immediately: supervise it with the wait tool (target: that id). Give it a self-contained prompt with " +
        "every path, requirement, and constraint — it sees none of this conversation. You must name the provider " +
        "AND the model: this spends a real allowance and nothing is chosen for you. Call the providers tool for " +
        "what is connected and what still has room.",
    inputSchema: {
        type: "object",
        properties: {
            prompt: { type: "string", description: "The child's whole task, self-contained." },
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
            return JSON.stringify({ ok: false, message: "A child needs a task: pass `prompt`." });
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
        return JSON.stringify(
            result.ok ? { ok: true, child: result.id, note: `Running. Supervise it with wait(target: "${result.id}").` } : result,
        );
    },
});

// Catalogue as its own tool, beside spawn: a required field is only fair if its answer is one call away.
const providersTool = (children: NonNullable<AgentRequest["children"]>): SDKCustomTool => ({
    description:
        "What a child agent could be started on right now: every provider this sandbox has connected, its " +
        "models, and how much allowance each still has. Models whose every connected account is at its cap are " +
        "left out, so what this shows is what can actually run.",
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: async () => JSON.stringify({ ok: true, providers: await children.providers() }),
});

// Wait ceiling/default match the harness tool's; long enough for a real child, short enough within the turn.
const WAIT_DEFAULT_S = 600;
const WAIT_MAX_S = 1800;

const sendTool = (children: NonNullable<AgentRequest["children"]>): SDKCustomTool => ({
    description:
        "Steer or continue an agent you started. A working child gets the message mid-turn (where its runtime " +
        "takes one); a finished child runs a follow-up turn on its own conversation, continuing its session, so " +
        "refinement costs a message rather than a fresh agent. Supervise the follow-up with the wait tool.",
    inputSchema: {
        type: "object",
        properties: {
            child: { type: "string", description: "The child's id, from spawn." },
            message: { type: "string", description: "What to tell it, self-contained." },
        },
        required: ["child", "message"],
    },
    execute: async (args) => {
        const child = typeof args["child"] === "string" ? args["child"] : "";
        const message = typeof args["message"] === "string" ? args["message"] : "";
        if (child === "" || message === "") {
            return JSON.stringify({ ok: false, message: "Pass the child's id and a message." });
        }
        return JSON.stringify(await children.send(child, message));
    },
});

const answerTool = (children: NonNullable<AgentRequest["children"]>): SDKCustomTool => ({
    description:
        "Answer a QUESTION a child you started is parked on (the wait tool reports blocked and carries the " +
        "question). Pass your picks keyed by the question's own text, values as chosen option labels or your own " +
        "words. Only questions: a permission hold or a plan approval is the owner's consent to give, and this " +
        "tool refuses those.",
    inputSchema: {
        type: "object",
        properties: {
            child: { type: "string", description: "The child's id, from spawn." },
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
            return JSON.stringify({ ok: false, message: "Pass the child's id and your answers." });
        }
        const answers: Record<string, string[]> = {};
        for (const [question, picks] of Object.entries(raw)) {
            answers[question] = Array.isArray(picks) ? picks.filter((entry): entry is string => typeof entry === "string") : [String(picks)];
        }
        return JSON.stringify(await children.answer(child, answers));
    },
});

const waitTool = (request: AgentRequest): SDKCustomTool => ({
    description:
        "Wait until an agent you started needs you. Blocks until the target is blocked on input or finishes, " +
        'whichever comes first, then returns its status and last report. Target a spawned child by its id, or "any" ' +
        "for whichever of this conversation's children moves first. On timeout it returns the current state: call " +
        "it again to keep waiting.",
    inputSchema: {
        type: "object",
        properties: {
            target: { type: "string", description: 'The child\'s id, or "any".' },
            until: { type: "array", items: { type: "string", enum: ["blocked", "finished"] }, description: 'Default ["blocked","finished"].' },
            timeoutSeconds: { type: "number", description: `Default ${WAIT_DEFAULT_S}, at most ${WAIT_MAX_S}.` },
        },
        required: ["target"],
    },
    execute: async (args) => {
        if (request.conversationId === undefined) {
            return JSON.stringify({ outcome: "unknown-target", note: "This turn has no conversation, so it has no children to wait on." });
        }
        const target = typeof args["target"] === "string" ? args["target"] : "any";
        const until = (Array.isArray(args["until"]) ? args["until"] : []).filter(
            (entry): entry is SubagentWaitUntil => entry === "blocked" || entry === "finished",
        );
        const seconds = typeof args["timeoutSeconds"] === "number" ? Math.min(Math.max(args["timeoutSeconds"], 5), WAIT_MAX_S) : WAIT_DEFAULT_S;
        const result = await waitForSubagent(request.conversationId, {
            ...(target !== "any" ? { target } : {}),
            until: until.length > 0 ? until : ["blocked", "finished"],
            timeoutMs: Math.round(seconds * 1000),
            signal: request.signal,
        });
        // Blocked child's whole question rides along, options included: lets a parent answer, not just report.
        const question = result.outcome === "blocked" && result.matched !== undefined ? request.children?.pendingQuestion(result.matched.id) : undefined;
        return JSON.stringify({
            outcome: result.outcome,
            ...(result.matched !== undefined ? { agent: result.matched } : {}),
            ...(question !== undefined ? { question } : {}),
        });
    },
});

// unattended is the one condition that changes ask's answer: a card on an unwatched turn would deadlock, not just go
// unused. The supervision set isn't card-shaped and rides unattended turns too; a child settles on its own clock.
export const cursorCustomTools = (request: AgentRequest, push: (event: AgentEvent) => void): Record<string, SDKCustomTool> => ({
    ...(request.unattended === true ? {} : { ask: askTool(request, push) }),
    ...(request.children !== undefined
        ? {
              spawn: spawnTool(request.children),
              providers: providersTool(request.children),
              wait: waitTool(request),
              send: sendTool(request.children),
              answer: answerTool(request.children),
          }
        : {}),
});

// stdio servers are the browser stack; environment passes whole, not a delta, since Cursor spawns them itself, not
// merging over an inherited one. In-process SDK instances are skipped: the gap behind mcp:"tools", not "full".
export const cursorMcpServers = (request: AgentRequest): Record<string, CursorMcpServer> => {
    const servers: Record<string, CursorMcpServer> = {};
    for (const tool of request.tools ?? []) {
        servers[tool.name] = {
            type: "http",
            url: tool.url,
            ...(tool.token !== undefined ? { headers: { Authorization: `Bearer ${tool.token}` } } : {}),
        };
    }
    for (const [name, server] of Object.entries(request.sdkServers ?? {})) {
        if (server.type !== undefined && server.type !== "stdio") {
            continue;
        }
        // An instance, not a process spec, has no command; tested directly since the type narrowing above misses it.
        const spec = server as { command?: unknown; args?: unknown; env?: unknown; cwd?: unknown };
        if (typeof spec.command !== "string") {
            continue;
        }
        servers[name] = {
            type: "stdio",
            command: spec.command,
            ...(Array.isArray(spec.args) ? { args: spec.args as string[] } : {}),
            ...(typeof spec.env === "object" && spec.env !== null ? { env: spec.env as Record<string, string> } : {}),
            ...(typeof spec.cwd === "string" ? { cwd: spec.cwd } : {}),
        };
    }
    return servers;
};

// Cursor's custom-tool results are JSON values; nothing here needs the richer content shape.
export type CursorToolResult = SDKJsonValue;
