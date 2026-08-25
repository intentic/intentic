import type { McpServerConfig as CursorMcpServer, SDKCustomTool, SDKJsonValue, ToolName } from "@cursor/sdk";
import type { AgentEvent, AskQuestion } from "@intentic/sandbox-contract";
import { createRequest } from "../agent/agent-requests.js";
import type { AgentRequest } from "../agent/agent.js";
import { formatAnswers } from "../agent/agent.js";
import { waitForSubagent, type SubagentWaitUntil } from "../agent/subagents.js";

/* WHAT THE TURN'S TOOLS BECOME ON CURSOR'S RUNTIME. Three seams, and between them they are the whole reason
 * this provider's `mcp` axis reads "tools" rather than "browser":
 *
 *   · the turn's remote MCP tools (connected accounts, the platform's integrations) → Cursor's `http` servers;
 *   · the browser stack, which this repo already produces as stdio process specs → Cursor's `stdio` servers;
 *   · the daemon's own in-process tools → `customTools`, host callbacks Cursor calls back into this process.
 *
 * The third is the one that does not exist on any other foreign runtime here, and it is what makes a real
 * question card possible: a tool whose handler runs in the daemon can park on a person, which a tool running
 * inside a vendor's own loop can never do. */

/* THE ASK TOOL, and the reason Cursor's own is switched off beside it.
 *
 * Cursor ships an `askQuestion` built-in, and in a headless run it has been reported to answer itself — the
 * model receives a fabricated "Questions skipped by the user" for a question no person ever saw, and then acts
 * on the consent that implies. That is the worst failure mode available to an agent that can run commands, so
 * the built-in goes in `disallowedTools` (see `TOOLS_WITHHELD`) and this replaces it.
 *
 * This one cannot fabricate anything, because it is not a model-side simulation of asking: the handler runs
 * here, raises the same card every other provider raises, and returns only once a person or the turn's abort
 * has settled it. The schema is deliberately identical to the Claude path's `ask` (agent.ts askServer), so a
 * model trained on that call site writes a valid call here and the answers come back phrased the same way. */
const askTool = (request: AgentRequest, push: (event: AgentEvent) => void): SDKCustomTool => ({
    description:
        'Ask the user 1-4 clarifying multiple-choice questions and wait for their answers. Use this whenever you need the user to choose between options before proceeding. Each question has 2-4 options; do NOT add an "Other" option: a free-text choice is provided automatically. Set multiSelect when several options may be picked together.',
    // JSON Schema rather than zod: Cursor takes the schema as data and hands it to the model, where the Claude
    // SDK's `tool()` helper compiles one from a zod object. Same shape, one layer lower.
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
        // Named with its conversation, like the Claude path's: dismissing this card ends the turn, and the
        // route that takes the dismissal has to be able to name the turn it ends.
        const { id, wait } = createRequest("question", { kind: "question", requestId: "", cancelled: true }, request.conversationId);
        push({ kind: "question", requestId: id, questions });
        const { reply, resolved } = await wait(request.signal);
        // The picks belong in the frame log and not only in this tool's result: they are what a replayed or
        // second-window transcript freezes the card with.
        push(resolved);
        return formatAnswers(questions, reply);
    },
});

/* THE BUILT-INS THIS RUNTIME DOES NOT GET, and why each one goes.
 *
 * `askQuestion` is replaced by the tool above, for the fabricated-consent reason it documents.
 *
 * Nothing else is withheld. It is tempting to also drop `task` (Cursor's subagent tool) on the grounds that the
 * daemon cannot see inside a subagent's turn — but a subagent that runs is better than a capability removed,
 * its tool calls still arrive on the same delta stream, and the model plans around having it. */
export const TOOLS_WITHHELD: readonly ToolName[] = ["askQuestion"];

/* THE SPAWN/WAIT PAIR, the cross-provider supervision surface on Cursor's runtime — the same two calls the
 * Claude Code loop mounts as an SDK MCP server (agent/subagent-wait.ts), through the seam Cursor actually
 * has. The engine arrives on the request (planCursorTurn sets it under the full-agency predicate), so this
 * module never re-derives the gate; the wait reads the same roster primitive the harness's tool does, which
 * is what makes a child spawned from a Cursor turn and one spawned from a Claude turn indistinguishable to
 * everything that watches. */
const spawnTool = (spawn: NonNullable<AgentRequest["spawn"]>): SDKCustomTool => ({
    description:
        "Start a full agent on any connected provider (claude, codex, grok, kimi, gemini, cursor) to work on a " +
        "task of its own. It runs as a separate conversation in its own isolated worktree and keeps working " +
        "after your turn ends; its finished work lands the way any agent's does. Returns the child's id " +
        "immediately: supervise it with the wait tool (target: that id). Give it a self-contained prompt with " +
        "every path, requirement, and constraint — it sees none of this conversation.",
    inputSchema: {
        type: "object",
        properties: {
            prompt: { type: "string", description: "The child's whole task, self-contained." },
            description: { type: "string", description: "One line naming the task, for the board and the roster." },
            provider: { type: "string", description: "Which provider serves it. Leave it out for Claude." },
            model: { type: "string", description: "Which model, e.g. composer-2.5 on cursor. Leave it out for the provider's default." },
            effort: { type: "string", description: "How hard it should think, where the provider offers a choice." },
        },
        required: ["prompt"],
    },
    execute: async (args) => {
        const prompt = typeof args["prompt"] === "string" ? args["prompt"] : "";
        if (prompt === "") {
            return JSON.stringify({ ok: false, message: "A child needs a task: pass `prompt`." });
        }
        const text = (key: string): string | undefined => (typeof args[key] === "string" && args[key] !== "" ? (args[key] as string) : undefined);
        const [description, provider, model, effort] = [text("description"), text("provider"), text("model"), text("effort")];
        const result = await spawn({
            prompt,
            ...(description !== undefined ? { description } : {}),
            ...(provider !== undefined ? { provider } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(effort !== undefined ? { effort } : {}),
        });
        return JSON.stringify(
            result.ok ? { ok: true, child: result.id, note: `Running. Supervise it with wait(target: "${result.id}").` } : result,
        );
    },
});

// One wait's ceiling and default, the harness tool's numbers (subagent-wait.ts): long enough for a real child,
// short enough that a forgotten wait returns within the turn; a parent that wants longer calls again.
const WAIT_DEFAULT_S = 600;
const WAIT_MAX_S = 1800;

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
        return JSON.stringify({ outcome: result.outcome, ...(result.matched !== undefined ? { agent: result.matched } : {}) });
    },
});

/* The daemon-side tools a turn hands Cursor. `unattended` is the one condition that changes the ASK's answer,
 * and it is the same rule the Claude Code loop and the Codex adapter both apply: a benchmark, a schedule or
 * another program started this turn, so a card is not merely useless but a DEADLOCK — it parks the turn on an
 * answer that can never arrive and burns until something aborts it. A turn nobody is watching decides for
 * itself. The spawn/wait pair is NOT card-shaped and rides unattended turns too: a child of a loop iteration
 * settles on its own clock, deadlocking nothing. */
export const cursorCustomTools = (request: AgentRequest, push: (event: AgentEvent) => void): Record<string, SDKCustomTool> => ({
    ...(request.unattended === true ? {} : { ask: askTool(request, push) }),
    ...(request.spawn !== undefined ? { spawn: spawnTool(request.spawn), wait: waitTool(request) } : {}),
});

/* The turn's MCP servers, in Cursor's own spelling.
 *
 * REMOTE TOOLS pass through almost unchanged: both sides model an http MCP endpoint with headers, so the only
 * translation is where the bearer goes.
 *
 * STDIO SERVERS are the browser stack, which this repo builds as Claude-SDK process specs. Only the process
 * fields cross over, and the environment is passed WHOLE rather than as a delta: unlike Codex's per-thread
 * config (which app-server merges over an environment it has already inherited), Cursor spawns these itself
 * from what is given, so trimming to a delta would start the browser with no environment at all.
 *
 * In-process SDK server INSTANCES are skipped, and that is the one gap behind the `mcp: "tools"` axis rather
 * than "full": they are live objects in this daemon, not processes anything can spawn. What the daemon most
 * needs from them (the ask tool) is supplied as a custom tool above, which is the same capability through a
 * seam Cursor actually has. */
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
        // An SDK server config that is an instance rather than a process spec has no `command`; the type
        // narrowing above does not catch that on its own, so it is tested for what it must have.
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

// Cursor's custom-tool results are JSON values; nothing here needs the richer content shape, so this is the
// one narrowing the callers above share.
export type CursorToolResult = SDKJsonValue;
