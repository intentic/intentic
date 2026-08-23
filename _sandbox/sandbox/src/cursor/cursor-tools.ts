import type { McpServerConfig as CursorMcpServer, SDKCustomTool, SDKJsonValue, ToolName } from "@cursor/sdk";
import type { AgentEvent, AskQuestion } from "@intentic/sandbox-contract";
import { createRequest } from "../agent/agent-requests.js";
import type { AgentRequest } from "../agent/agent.js";
import { formatAnswers } from "../agent/agent.js";

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

/* The daemon-side tools a turn hands Cursor. `unattended` is the one condition that changes the answer, and it
 * is the same rule the Claude Code loop and the Codex adapter both apply: a benchmark, a schedule or another
 * program started this turn, so a card is not merely useless but a DEADLOCK — it parks the turn on an answer
 * that can never arrive and burns until something aborts it. A turn nobody is watching decides for itself. */
export const cursorCustomTools = (request: AgentRequest, push: (event: AgentEvent) => void): Record<string, SDKCustomTool> =>
    request.unattended === true ? {} : { ask: askTool(request, push) };

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
