import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readBody, sendJson } from "@intentic/testing/http-fake";
import {
    assistantMessage,
    execCommandCall,
    execScriptCall,
    functionCall,
    type FakeUsage,
    type JsonValue,
    responseFrames,
    type ResponsesRequest,
    type SseFrame,
    toolNames,
} from "./responses.js";

// Fakes the model, one layer past the CLI: the real `codex` binary reads its real config, assembles its real prompt,
// and posts here, so the test exercises the real CLI/config/prompt path instead of a scripted event list standing in
// for it. `requests` records what actually reached the wire, turning capability claims into assertions.

// One step of a scripted conversation, consumed in order; the last one repeats so an extra request (a retry, a
// follow-up) gets it again instead of a 500.
export interface ScriptedStep {
    /** Answer with prose and end the turn. */
    readonly text?: string;
    // Runs a shell command via exec_command, the flat tool app-server publishes; execScript covers codex exec.
    readonly shell?: string;
    // Runs a shell command as codex exec's JS-input exec tool; against app-server this is a tool-router error.
    readonly execScript?: string;
    /** Call a named function tool with these arguments, then continue to the next step. */
    readonly call?: { readonly name: string; readonly args: JsonValue };
    /** Fail this request at the HTTP layer: how a rate limit, an auth refusal or an outage is scripted. */
    readonly failWith?: { readonly status: number; readonly body: JsonValue };
    /** Token counts for this step's `response.completed`. */
    readonly usage?: FakeUsage;
}

export interface FakeModelOptions {
    /** 0 (the default) takes any free port, the only safe choice when suites run in parallel. */
    readonly port?: number;
    readonly script?: readonly ScriptedStep[];
    // Answers by request content, not position: immune to retries and cross-test ordering.
    readonly respond?: (request: ResponsesRequest) => ScriptedStep | undefined;
    /** Bearer the OpenAI surface requires. Unset accepts any, which is what most scenarios want. */
    readonly requireKey?: string;
}

export interface FakeModel {
    /** What to configure as the provider's base URL. The CLI appends `/v1` itself, so this carries no path. */
    readonly baseUrl: string;
    readonly port: number;
    /** Every Responses body this model was sent, in order: what a test asserts actually reached the wire. */
    readonly requests: readonly ResponsesRequest[];
    /** Bearer tokens seen, in order, so a test can prove which credential the CLI used. */
    readonly bearers: readonly (string | undefined)[];
    close(): Promise<void>;
}

const sendSse = (response: ServerResponse, frames: readonly SseFrame[]): void => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const [event, data] of frames) {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    response.end();
};

// Chat Completions streams nameless frames and ends with a literal [DONE] instead of a typed event, so it can't share
// sendSse. A stream that merely stopped would hang the reader until a timeout.
const sendChatSse = (response: ServerResponse, chunks: readonly JsonValue[]): void => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    response.write("data: [DONE]\n\n");
    response.end();
};

// Empty script answers with prose, so the simplest turn needs no script at all.
const stepFor = (script: readonly ScriptedStep[], index: number): ScriptedStep => {
    if (script.length === 0) {
        return { text: "ok" };
    }
    return script[Math.min(index, script.length - 1)]!;
};

// Picks the shell form from the tools the request actually offered, not from test config, so one scripted command works
// across both model families. Prefers the flat form when both are offered: it has a schema, not just a script.
const shellCall = (request: ResponsesRequest, callId: string, command: string): JsonValue => {
    const offered = toolNames(request);
    if (offered.some((name) => name === "exec_command" || name.endsWith(".exec_command"))) {
        return execCommandCall(callId, command);
    }
    return execScriptCall(callId, command);
};

const framesFor = (step: ScriptedStep, index: number, request: ResponsesRequest): readonly SseFrame[] => {
    const id = `resp_${index + 1}`;
    const callId = `call_${index + 1}`;
    if (step.shell !== undefined) {
        return responseFrames(id, shellCall(request, callId, step.shell), step.usage ?? {});
    }
    if (step.execScript !== undefined) {
        return responseFrames(id, execScriptCall(callId, step.execScript), step.usage ?? {});
    }
    if (step.call !== undefined) {
        return responseFrames(id, functionCall(callId, step.call.name, step.call.args), step.usage ?? {});
    }
    return responseFrames(id, assistantMessage(`msg_${index + 1}`, step.text ?? "ok"), step.usage ?? {});
};

// OpenCode's dialect: tool calls arrive as delta.tool_calls fragments, and finish_reason ends the turn, not a typed
// event. id/created are fixed so a fixture diffs cleanly across CLI versions.
const chatChunks = (step: ScriptedStep, index: number): readonly JsonValue[] => {
    const id = `chatcmpl_${index + 1}`;
    const head = { id, object: "chat.completion.chunk", created: 0, model: "fake-model" };
    if (step.shell !== undefined) {
        return [
            {
                ...head,
                choices: [
                    {
                        index: 0,
                        delta: {
                            role: "assistant",
                            tool_calls: [
                                {
                                    index: 0,
                                    id: `call_${index + 1}`,
                                    type: "function",
                                    function: { name: "bash", arguments: JSON.stringify({ command: step.shell }) },
                                },
                            ],
                        },
                        finish_reason: null,
                    },
                ],
            },
            { ...head, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ];
    }
    return [
        { ...head, choices: [{ index: 0, delta: { role: "assistant", content: step.text ?? "ok" }, finish_reason: null }] },
        {
            ...head,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: step.usage?.inputTokens ?? 1, completion_tokens: step.usage?.outputTokens ?? 1, total_tokens: 2 },
        },
    ];
};

// Anthropic Messages reply for the Claude Code loop; a smaller surface than Responses since the SDK assembles the turn
// itself.
const anthropicFrames = (step: ScriptedStep, index: number): readonly SseFrame[] => {
    const text = step.text ?? "ok";
    return [
        [
            "message_start",
            {
                type: "message_start",
                message: {
                    id: `msg_${index + 1}`,
                    type: "message",
                    role: "assistant",
                    model: "fake-claude",
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: step.usage?.inputTokens ?? 1, output_tokens: step.usage?.outputTokens ?? 1 },
                },
            },
        ],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
            "message_delta",
            {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: step.usage?.outputTokens ?? 1 },
            },
        ],
        ["message_stop", { type: "message_stop" }],
    ];
};

export const startFakeModel = async (options: FakeModelOptions = {}): Promise<FakeModel> => {
    const script = options.script ?? [];
    const requests: ResponsesRequest[] = [];
    const bearers: (string | undefined)[] = [];
    let answered = 0;

    const server: Server = createServer((request, response) => {
        void (async () => {
            const body = await readBody(request);
            const authorization = request.headers.authorization;
            const bearer = authorization?.startsWith("Bearer ") === true ? authorization.slice("Bearer ".length).trim() : undefined;
            const url = request.url ?? "";

            if (url.includes("/responses")) {
                bearers.push(bearer);
                if (options.requireKey !== undefined && bearer !== options.requireKey) {
                    sendJson(response, 401, { error: { message: "fake-model: wrong or missing bearer", type: "invalid_request_error" } });
                    return;
                }
                // An unparsable body is the test's bug, not the CLI's; say so instead of a deep JSON-reviver stack
                // trace.
                let parsed: ResponsesRequest;
                try {
                    parsed = JSON.parse(body) as ResponsesRequest;
                } catch {
                    sendJson(response, 400, { error: { message: `fake-model could not parse a Responses body: ${body.slice(0, 200)}` } });
                    return;
                }
                requests.push(parsed);
                const index = answered;
                answered += 1;
                const step = options.respond?.(parsed) ?? stepFor(script, index);
                if (step.failWith !== undefined) {
                    sendJson(response, step.failWith.status, step.failWith.body);
                    return;
                }
                sendSse(response, framesFor(step, index, parsed));
                return;
            }

            if (url.includes("/chat/completions")) {
                bearers.push(bearer);
                if (options.requireKey !== undefined && bearer !== options.requireKey) {
                    sendJson(response, 401, { error: { message: "fake-model: wrong or missing bearer", type: "invalid_request_error" } });
                    return;
                }
                // Synthesizes `input` from `messages` so the same readers (userMessages, etc.) work on both dialects.
                const parsedChat = JSON.parse(body) as {
                    messages?: readonly { role?: string; content?: unknown }[];
                    model?: string;
                    tools?: JsonValue;
                };
                requests.push({
                    model: parsedChat.model,
                    ...(parsedChat.tools === undefined ? {} : { tools: parsedChat.tools }),
                    input: (parsedChat.messages ?? []).map((message) => ({
                        type: "message",
                        role: String(message.role),
                        content: [
                            { type: "input_text", text: typeof message.content === "string" ? message.content : JSON.stringify(message.content) },
                        ],
                    })),
                } as ResponsesRequest);
                const index = answered;
                answered += 1;
                const step = options.respond?.(requests.at(-1)!) ?? stepFor(script, index);
                if (step.failWith !== undefined) {
                    sendJson(response, step.failWith.status, step.failWith.body);
                    return;
                }
                sendChatSse(response, chatChunks(step, index));
                return;
            }

            if (url.includes("/messages")) {
                bearers.push(bearer);
                const index = answered;
                answered += 1;
                const step = stepFor(script, index);
                if (step.failWith !== undefined) {
                    sendJson(response, step.failWith.status, step.failWith.body);
                    return;
                }
                sendSse(response, anthropicFrames(step, index));
                return;
            }

            // Several clients probe this before their first turn and read a 404 as unreachable rather than no listing.
            if (url.includes("/models")) {
                sendJson(response, 200, { object: "list", data: [{ id: "fake-model", object: "model", owned_by: "intentic" }] });
                return;
            }

            // Refuses by name rather than answering everything, so a CLI on the wrong surface fails with a readable
            // reason.
            sendJson(response, 404, { error: { message: `fake-model serves /v1/responses, /v1/chat/completions and /v1/messages, not ${url}` } });
        })();
    });

    await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        requests,
        bearers,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error === undefined ? resolve() : reject(error)));
            }),
    };
};
