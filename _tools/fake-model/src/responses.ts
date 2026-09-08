// OpenAI Responses wire as Codex actually speaks it (read off the CLI, not docs): request `input` array, SSE event
// names, and the usage block response.completed needs or the CLI reports zero spend. Codex publishes no direct shell
// tool; it's a JS-input `exec` tool reaching `tools.exec_command({cmd: string})`, and cmd must be a string, not an
// array.

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** One SSE frame: the `event:` name and the object that rides its `data:` line. */
export type SseFrame = readonly [string, JsonValue];

// Token block response.completed carries; Codex requires the two detail objects too, or it can't parse it, so they're
// always written.
export interface FakeUsage {
    readonly inputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningTokens?: number;
}

const usageBlock = (usage: FakeUsage): JsonValue => {
    const input = usage.inputTokens ?? 1;
    const output = usage.outputTokens ?? 1;
    return {
        input_tokens: input,
        input_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
        output_tokens: output,
        output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
        total_tokens: input + output,
    };
};

// Minimal valid stream: Codex reads the item whole from response.output_item.done rather than assembling deltas. A test
// needing partial-delta behaviour scripts its own frames.
export const responseFrames = (id: string, item: JsonValue, usage: FakeUsage = {}): readonly SseFrame[] => [
    ["response.created", { type: "response.created", response: { id } }],
    ["response.output_item.done", { type: "response.output_item.done", item }],
    ["response.completed", { type: "response.completed", response: { id, usage: usageBlock(usage) } }],
];

/** output_text, not text: the other spelling parses and renders as nothing. */
export const assistantMessage = (id: string, text: string): JsonValue => ({
    type: "message",
    id,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text }],
});

// Two shapes, same binary: `codex app-server --stdio` (this daemon) uses a flat `exec_command(cmd: string)` tool;
// `codex exec` instead offers an `exec` tool taking JS that calls `tools.exec_command({cmd})`.
export const execCommandCall = (callId: string, command: string): JsonValue =>
    functionCall(callId, "exec_command", { cmd: command });

// `codex exec`'s form. JSON.stringify guards a quote in `command` from closing the script's string literal. `text(r)`
// is what returns the result to the model; otherwise the isolate discards it.
export const execScriptCall = (callId: string, command: string): JsonValue => ({
    type: "custom_tool_call",
    id: `ctc_${callId}`,
    call_id: callId,
    name: "exec",
    input: `const r = await tools.exec_command({cmd: ${JSON.stringify(command)}}); text(r);`,
});

/** A plain function tool call (`request_user_input` and the collaboration tools take this form, not `exec`'s). */
export const functionCall = (callId: string, name: string, args: JsonValue): JsonValue => ({
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
});

// Three reader vocabularies over a request body, not assertions: a suite states its own expectation. What moves between
// CLI releases is the SHAPE these encapsulate.

export interface ResponsesRequest {
    readonly model?: string;
    readonly input: readonly JsonValue[];
    readonly [key: string]: JsonValue | undefined;
}

const textOf = (content: unknown): string => {
    if (!Array.isArray(content)) {
        return "";
    }
    return content.map((block) => (typeof block === "object" && block !== null ? String((block as Record<string, unknown>)["text"] ?? "") : "")).join(" ");
};

const messagesOf = (request: ResponsesRequest, role: string): readonly string[] => {
    const found: string[] = [];
    for (const item of request.input) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            continue;
        }
        const record = item as Record<string, unknown>;
        if (record["type"] === "message" && record["role"] === role) {
            found.push(textOf(record["content"]));
        }
    }
    return found;
};

// Developer messages in wire order; an appended `developer_instructions` lands at the head of the first one, ahead of
// Codex's skills block.
export const developerMessages = (request: ResponsesRequest): readonly string[] => messagesOf(request, "developer");

// Top-level `instructions` field; empty string when absent is a statement about the surface, not the prompt.
export const baseInstructions = (request: ResponsesRequest): string => {
    const value = (request as Record<string, unknown>)["instructions"];
    return typeof value === "string" ? value : "";
};

// Base prompt location depends on the MODEL, not the entry point: `gpt-5-codex` sends top-level `instructions`;
// `gpt-5.6-sol` sends the first developer message instead. This keeps an assertion valid across the catalog.
export const systemInstructions = (request: ResponsesRequest): string => {
    const top = baseInstructions(request);
    return top !== "" ? top : (developerMessages(request)[0] ?? "");
};

/** Last message is the turn's prompt; the one before it is Codex's environment context. */
export const userMessages = (request: ResponsesRequest): readonly string[] => messagesOf(request, "user");

// Reads tools from both surfaces the binary uses: the flat top-level `tools` field, and `additional_tools`' namespaced
// entries (reported as `namespace.name`). Reading only one under-reports what's offered.
export const toolNames = (request: ResponsesRequest): readonly string[] => {
    const names: string[] = [];
    const top = (request as Record<string, unknown>)["tools"];
    if (Array.isArray(top)) {
        for (const tool of top) {
            if (typeof tool !== "object" || tool === null) {
                continue;
            }
            const record = tool as Record<string, unknown>;
            // A namespace groups its own; web_search and friends carry a type but no name.
            if (record["type"] === "namespace" && Array.isArray(record["tools"])) {
                for (const nested of record["tools"]) {
                    names.push(`${String(record["name"])}.${String((nested as Record<string, unknown>)["name"])}`);
                }
                continue;
            }
            names.push(typeof record["name"] === "string" ? record["name"] : String(record["type"]));
        }
    }
    for (const item of request.input) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            continue;
        }
        const record = item as Record<string, unknown>;
        if (record["type"] !== "additional_tools" || !Array.isArray(record["tools"])) {
            continue;
        }
        for (const group of record["tools"]) {
            if (typeof group !== "object" || group === null) {
                continue;
            }
            const namespace = group as Record<string, unknown>;
            if (namespace["type"] !== "namespace" || !Array.isArray(namespace["tools"])) {
                names.push(String(namespace["name"]));
                continue;
            }
            for (const tool of namespace["tools"]) {
                const named = tool as Record<string, unknown>;
                names.push(`${String(namespace["name"])}.${String(named["name"])}`);
            }
        }
    }
    return names;
};

// Same tool is bare `request_user_input` on one surface, namespaced on the other; matching only one spelling silently
// inverts on half the catalog. Matches either form.
export const hasTool = (request: ResponsesRequest, name: string): boolean =>
    toolNames(request).some((offered) => offered === name || offered.endsWith(`.${name}`));

// Outputs the CLI sent back for tool calls, keyed by call id: the only proof a command actually ran, not just was
// reported as run.
export const toolOutputs = (request: ResponsesRequest): ReadonlyMap<string, string> => {
    const outputs = new Map<string, string>();
    for (const item of request.input) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            continue;
        }
        const record = item as Record<string, unknown>;
        if (record["type"] !== "custom_tool_call_output" && record["type"] !== "function_call_output") {
            continue;
        }
        const output = record["output"];
        outputs.set(String(record["call_id"]), typeof output === "string" ? output : textOf(output));
    }
    return outputs;
};
