import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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

/* A MODEL THAT DOES WHAT THE TEST SAYS, so a provider's REAL CLI can be driven without a token, a network, or a
 * vendor's mood.
 *
 * This is the piece that turns "we believe Codex still reads that config key" into a test. Every provider
 * adapter in this repo is covered by a fake at the seam BELOW the CLI: a scripted event list stands in for the
 * app-server, and the CLI itself never runs. That proves the mapping from provider events to AgentEvents and
 * proves nothing about the half where the failures actually happened, the argv, the config file, the env, the
 * wire. Both sides of that seam are ours, so a vendor changing its behaviour moves neither: the fake and the
 * parser drift together and the suite stays green while the product breaks.
 *
 * So this server replaces the MODEL instead, one layer further out. The real `codex` binary starts, reads the
 * real config.toml, parses the real hooks, assembles its real prompt, and posts it here. What comes back is
 * whatever the test scripted. The turn is deterministic and costs nothing, and everything between the daemon
 * and the model is the shipped article.
 *
 * WHAT A TEST GETS THAT IT CANNOT GET ANYWHERE ELSE is `requests`: the bodies the CLI sent. A capability the
 * catalog claims (`instructions: "replace"`, the question tool being registered exactly when asked for) is a
 * statement about what reaches the model, so it can only be checked by reading what reached the model. Those
 * claims currently rest on comments recording what someone once saw on the wire; here they are assertions.
 *
 * DIALECTS. `/v1/responses` is OpenAI's Responses API, which is what Codex speaks (`wire_api = "responses"`)
 * and what the translator serves. `/v1/messages` is Anthropic's, for the Claude Code loop via ANTHROPIC_BASE_URL.
 * Each refuses the other's route rather than answering everything, so a base URL pointed at the wrong surface
 * fails here with a sentence naming it instead of passing by accident. */

/* One step of a scripted conversation: what the model "does" when the CLI asks for the Nth time.
 *
 * Steps are consumed in order and the LAST one repeats, so a script ends in a state rather than falling off:
 * a CLI that asks once more (a retry, a follow-up after a tool result) gets the final step again instead of a
 * 500 the test then has to explain. */
export interface ScriptedStep {
    /** Answer with prose and end the turn. */
    readonly text?: string;
    /* Run a shell command, then continue to the next step. Targets `exec_command`, the flat function tool
     * `codex app-server` publishes, which is the surface this daemon drives. Use `execScript` for the other
     * one. */
    readonly shell?: string;
    /* Run a shell command the way `codex exec` offers one: as JavaScript inside the `exec` custom tool. Only
     * for suites driving that CLI surface; against app-server it produces a tool-router error, not a command. */
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
    /* ANSWER BY WHAT WAS ASKED, instead of by how many times. Given a request, return the step to answer it
     * with, or undefined to fall through to `script`.
     *
     * A positional script is the simplest thing that works and the wrong thing for two situations that come up
     * constantly. A CLI that RETRIES consumes steps the scenario never meant to spend, so a flaky network turns
     * a deterministic test into a different one. And a runtime whose server cannot be reconfigured per test
     * (OpenCode fixes provider config at spawn) has to share one model across a whole suite, where a positional
     * script couples every test to the order of the others.
     *
     * Keying off the prompt removes both: each scenario recognizes its own request and answers it, retries get
     * the same answer again, and tests can run in any order. */
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

const readBody = async (request: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
};

const sendSse = (response: ServerResponse, frames: readonly SseFrame[]): void => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const [event, data] of frames) {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    response.end();
};

/* Chat Completions streams NAMELESS frames and ends with a literal `[DONE]` sentinel rather than a typed
 * terminal event, so it cannot share `sendSse`: a reader of this dialect ignores `event:` lines and waits for
 * that exact string, and a stream that merely stopped would hang it until a timeout. */
const sendChatSse = (response: ServerResponse, chunks: readonly JsonValue[]): void => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    response.write("data: [DONE]\n\n");
    response.end();
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    response.end(text);
};

// The step that governs request N, with the last one repeating (see ScriptedStep). An empty script answers
// with prose, so the simplest possible turn needs no script at all.
const stepFor = (script: readonly ScriptedStep[], index: number): ScriptedStep => {
    if (script.length === 0) {
        return { text: "ok" };
    }
    return script[Math.min(index, script.length - 1)]!;
};

/* WHICH SHELL FORM THIS REQUEST WANTS, read off the tools the CLI just offered rather than configured by the
 * test. The two model families take different ones (`exec_command` as a flat function, or the `exec` custom
 * tool taking JavaScript), and a step aimed at the wrong one comes back as a tool-router error rather than as a
 * command, which a suite would read as the runtime refusing to execute.
 *
 * Deciding here is what lets a scenario say "run this command" once and have it hold across the catalog. The
 * flat form is preferred when both are somehow offered: it is the one with a schema rather than a script. */
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

/* THE CHAT COMPLETIONS REPLY, the dialect OpenCode reaches every custom provider through
 * (`@ai-sdk/openai-compatible`). A third shape rather than a variant of the first two: its tool calls arrive as
 * `delta.tool_calls` fragments on the choice, and a turn is finished by `finish_reason` rather than by a typed
 * terminal event.
 *
 * `id` and `created` are fixed rather than generated. A conformance fixture that changed on every run could not
 * be diffed between CLI versions, which is half of what recording one is for. */
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

/* The Anthropic Messages reply, for the Claude Code loop. A far smaller surface than Responses because the SDK
 * assembles the turn itself: one content block and a stop reason is a complete answer. */
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
                // A body that will not parse is the test's bug, not the CLI's, and saying so beats a stack
                // trace from inside a JSON reviver three frames down.
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
                // Recorded like a Responses body so one set of readers answers about either dialect; `input` is
                // synthesized from `messages` so `userMessages` means the same thing on both.
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

            /* A model listing, which several clients probe before their first turn and treat a 404 on as "this
             * provider is unreachable" rather than as "no listing". Answering it costs nothing and removes a
             * failure mode that has nothing to do with the scenario under test. */
            if (url.includes("/models")) {
                sendJson(response, 200, { object: "list", data: [{ id: "fake-model", object: "model", owned_by: "intentic" }] });
                return;
            }

            // Deliberately a refusal rather than an empty 200: a CLI pointed at the wrong surface must fail
            // with the path it asked for, which is the sentence that names the misconfiguration.
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
