/* THE OpenAI RESPONSES WIRE, AS CODEX ACTUALLY SPEAKS IT, and the one file that has to change when it moves.
 *
 * Every shape here was read off codex-cli 0.147 talking to a local server, not from documentation: the request
 * body's `input` array, the SSE event names, the two output-item forms a turn can carry, and the usage block
 * `response.completed` must include or the CLI reports the turn as having spent nothing.
 *
 * The tool surface is the part that surprises. Codex does NOT publish a shell tool the model calls directly; it
 * publishes ONE custom tool, `exec`, whose input is JavaScript source evaluated in a V8 isolate, and the shell
 * is reached from inside it as `await tools.exec_command({cmd: "…"})`. `cmd` is a STRING: handed the argv array
 * that reads more natural, the CLI answers "invalid type: sequence, expected a string" and the model sees a
 * failed script rather than a command. That is exactly the class of fact a hand-written fake cannot know and a
 * real CLI states for free. */

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** One SSE frame: the `event:` name and the object that rides its `data:` line. */
export type SseFrame = readonly [string, JsonValue];

/* The token block `response.completed` carries. Codex reads `input_tokens`/`output_tokens` and the two detail
 * objects; omitting the details is not a smaller answer but an unparseable one, so they are always written. */
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

/* One response, start to finish. Codex tolerates a stream that carries only these three frames: it wants the
 * item on `response.output_item.done` rather than assembled from deltas, which keeps a scripted turn a value
 * rather than a state machine. A test that needs partial-delta behaviour scripts the frames itself. */
export const responseFrames = (id: string, item: JsonValue, usage: FakeUsage = {}): readonly SseFrame[] => [
    ["response.created", { type: "response.created", response: { id } }],
    ["response.output_item.done", { type: "response.output_item.done", item }],
    ["response.completed", { type: "response.completed", response: { id, usage: usageBlock(usage) } }],
];

/** The assistant's prose. `output_text`, not `text`: the other spelling parses and renders as nothing. */
export const assistantMessage = (id: string, text: string): JsonValue => ({
    type: "message",
    id,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text }],
});

/* A SHELL COMMAND, IN THE TWO DIFFERENT SHAPES THE SAME BINARY OFFERS depending on how it was started. This is
 * the single most surprising thing the wire says, and no amount of reading the adapter would reveal it:
 *
 *   `codex app-server --stdio`, which is what this daemon drives, publishes a FLAT function tool named
 *      `exec_command`, whose one required argument is `cmd`, a shell string.
 *   `codex exec`, the CLI a delegated shell runs, publishes ONE custom tool named `exec` whose input is
 *      JavaScript source, and the shell is reached from inside it as `await tools.exec_command({cmd: "…"})`.
 *
 * Both are the same release of the same binary. A test written against the wrong one gets a tool-router error
 * rather than a command, which is why both live here and are named for the surface they belong to. */
export const execCommandCall = (callId: string, command: string): JsonValue =>
    functionCall(callId, "exec_command", { cmd: command });

/* The `codex exec` surface's form. JSON.stringify around the command is not decoration: a command carrying a
 * quote would otherwise close the script's string literal and the isolate would fail to parse a script the test
 * believed it had written. `text(r)` is what returns the result to the model instead of the isolate
 * discarding it. */
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

/* WHAT A REQUEST BODY SAYS, in the three vocabularies a conformance test asks about. These are readers rather
 * than assertions so a suite states its own expectation; what they encapsulate is the SHAPE, which is the part
 * that moves between CLI releases. */

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

/* The developer messages, in wire order. An APPEND (`developer_instructions`) lands here, at the head of the
 * first one, ahead of Codex's skills block. */
export const developerMessages = (request: ResponsesRequest): readonly string[] => messagesOf(request, "developer");

/* The top-level `instructions` field, when the request carries one. Empty string when it does not, which is a
 * statement about the surface rather than about the prompt, see `systemInstructions` below. */
export const baseInstructions = (request: ResponsesRequest): string => {
    const value = (request as Record<string, unknown>)["instructions"];
    return typeof value === "string" ? value : "";
};

/* THE BASE PROMPT, WHEREVER THIS MODEL FAMILY KEEPS IT, and the reader every capability assertion should use.
 *
 * The same CLI puts it in two different places depending on the MODEL, not on the entry point:
 *
 *   `gpt-5-codex` and its family send it as the top-level `instructions` field.
 *   `gpt-5.6-sol` and its family send it as the FIRST developer message instead, with the tools moved into a
 *      namespaced `additional_tools` item to match.
 *
 * A suite pinned to either one passes on half the models the product offers and fails on the other half for a
 * reason that has nothing to do with the capability under test. Asking "what is this turn's base prompt" and
 * letting this decide where to look is what makes `instructions: "replace"` assertable across the catalog
 * rather than against one model id that will age out. */
export const systemInstructions = (request: ResponsesRequest): string => {
    const top = baseInstructions(request);
    return top !== "" ? top : (developerMessages(request)[0] ?? "");
};

/** The user messages. The last one is the turn's prompt; the one before it is Codex's environment context. */
export const userMessages = (request: ResponsesRequest): readonly string[] => messagesOf(request, "user");

/* EVERY TOOL OFFERED ON THIS REQUEST, from both places the same binary puts them.
 *
 * `codex app-server` uses the ordinary top-level `tools` field, flat: `exec_command`, `request_user_input`, …
 * `codex exec` instead rides an `additional_tools` INPUT ITEM whose entries are namespaces, reported here as
 * `namespace.name` so the two surfaces stay distinguishable in an assertion.
 *
 * Reading only one of them is how a suite concludes that no tools were offered at all, which reads as a
 * capability being withheld rather than as the reader looking in the wrong place. */
export const toolNames = (request: ResponsesRequest): readonly string[] => {
    const names: string[] = [];
    const top = (request as Record<string, unknown>)["tools"];
    if (Array.isArray(top)) {
        for (const tool of top) {
            if (typeof tool !== "object" || tool === null) {
                continue;
            }
            const record = tool as Record<string, unknown>;
            // A namespace groups its own; `web_search` and friends carry a type and no name at all.
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

/* WAS THIS TOOL OFFERED, whichever surface this model family uses. The same tool is `request_user_input` on one
 * and `functions.request_user_input` on the other, so an assertion written against either spelling silently
 * inverts on half the catalog. Matches the bare name or any namespace's version of it. */
export const hasTool = (request: ResponsesRequest, name: string): boolean =>
    toolNames(request).some((offered) => offered === name || offered.endsWith(`.${name}`));

/* The outputs the CLI sent BACK for tool calls it ran, keyed by call id. This is where a test reads what a
 * command actually printed, which is the only proof that the CLI ran it rather than reporting that it had. */
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
