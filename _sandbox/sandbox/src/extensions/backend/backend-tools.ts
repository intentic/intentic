import { TimeoutError, withDeadline } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import type { ToolCard, ToolContent, ToolDefinition, ToolResult } from "@intentic/extension-api";
import type { ToolSource } from "@intentic/extension-api/runtime";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";

// The MCP server the backend host runs for an extension's `api.tools.serve`: the extension says which tools a card
// gets and what each does; this owns everything else, the handshake, the tool list, each call's deadline, turning an
// answer into MCP content. Runs in the host process, so it reads nothing of the daemon's.

// What one serve registration answers with, per card: the SDK runtime's own type, since it is the runtime's slot.
export type { ToolSource } from "@intentic/extension-api/runtime";

// A call gets this long before its signal aborts and the model reads a timeout. Far above any tool that answers from a
// remote API, and a bound rather than a budget: it exists so a hung call cannot hold the agent's turn forever.
export const TOOL_CALL_DEADLINE_MS = 10 * 60_000;

const PROTOCOL_VERSION = "2025-06-18";

const rpcError = (id: RpcMessage["id"], code: number, message: string): RpcMessage => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const isResult = (value: unknown): value is ToolResult =>
    typeof value === "object" && value !== null && Array.isArray((value as { content?: unknown }).content);

// A string answers as text, a ToolResult as itself, anything else as its JSON.
export const toToolResult = (value: unknown): ToolResult => {
    if (isResult(value)) {
        return value;
    }
    const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, undefined, 2);
    return { content: [{ type: "text", text } satisfies ToolContent] };
};

const failure = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

// Runs one call under the host's deadline and the client's own signal, whichever ends first; either aborts the call's
// signal and answers at once, whether or not the tool heeds it.
const runCall = async (tool: ToolDefinition, args: Readonly<Record<string, unknown>>, signal: AbortSignal, conversationId?: string): Promise<ToolResult> => {
    try {
        const answer = await withDeadline(
            async (both) => tool.call(args, { signal: both, ...(conversationId === undefined ? {} : { conversationId }) }),
            TOOL_CALL_DEADLINE_MS,
            { signal },
        );
        return toToolResult(answer);
    } catch (error) {
        if (error instanceof TimeoutError) {
            return failure(`${tool.name} did not answer within ${TOOL_CALL_DEADLINE_MS / 60_000} minutes`);
        }
        return failure(signal.aborted ? `${tool.name} was cancelled` : errorMessage(error));
    }
};

// One tool as `tools/list` names it. A declared effect is spelled by the helper the daemon's own tools use, both hints
// out; an undeclared one gets no annotations at all, as before `effect` existed.
const listed = (tool: ToolDefinition): Record<string, unknown> => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.effect === undefined ? {} : { annotations: toolAnnotations(tool.effect) }),
});

export interface ToolRequest {
    readonly card?: ToolCard;
    readonly conversationId?: string;
    readonly message: RpcMessage;
}

// Answers one JSON-RPC message for one card; undefined for a notification, which expects none.
export const answerToolMessage = async (
    extension: { readonly id: string; readonly source: ToolSource | undefined },
    request: ToolRequest,
    signal: AbortSignal,
): Promise<RpcMessage | undefined> => {
    const { message } = request;
    if (message.id === undefined) {
        return undefined;
    }
    switch (message.method) {
        case "initialize":
            return {
                jsonrpc: "2.0",
                id: message.id,
                result: {
                    protocolVersion: (message.params?.["protocolVersion"] as string | undefined) ?? PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: request.card?.id ?? extension.id, version: "1.0.0" },
                },
            };
        case "ping":
            return { jsonrpc: "2.0", id: message.id, result: {} };
        case "tools/list":
        case "tools/call":
            break;
        default:
            return rpcError(message.id, -32601, `unsupported method "${String(message.method)}"`);
    }
    if (extension.source === undefined) {
        return rpcError(message.id, -32603, `the "${extension.id}" backend serves no tools (it never called api.tools.serve)`);
    }
    let tools: readonly ToolDefinition[];
    try {
        tools = await extension.source(request.card);
    } catch (error) {
        return rpcError(message.id, -32603, `the "${extension.id}" tools could not be listed: ${errorMessage(error)}`);
    }
    if (message.method === "tools/list") {
        return {
            jsonrpc: "2.0",
            id: message.id,
            result: { tools: tools.map(listed) },
        };
    }
    const name = message.params?.["name"];
    const tool = tools.find((candidate) => candidate.name === name);
    // A tool the card no longer offers (a switch turned off since the list) is a refusal the model reads.
    if (tool === undefined) {
        return { jsonrpc: "2.0", id: message.id, result: failure(`no tool "${String(name)}" is offered to this card right now`) };
    }
    const args = (message.params?.["arguments"] ?? {}) as Readonly<Record<string, unknown>>;
    return { jsonrpc: "2.0", id: message.id, result: await runCall(tool, args, signal, request.conversationId) };
};
