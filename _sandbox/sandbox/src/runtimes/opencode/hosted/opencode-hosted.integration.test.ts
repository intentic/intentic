import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { requires } from "@intentic/testing/requires";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentRequest, OpenCodeCredential } from "../../../agent/providers/agent-request.js";
import { parkedCards } from "../../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import { createOpenCodeAgent, createOpenCodeRunner } from "../opencode-agent.js";
import { createOpenCodeService, type OpenCodeService } from "../opencode.js";
import type { OpenCodeRouteEntry } from "./opencode-routes.js";

// The hosted routes against a real `opencode serve` (the pinned 2.0.26 CLI): one provider entry per wire, each pointed at
// a model served from this test, so what is checked is that the entry the daemon writes is one OpenCode's bundled
// package dials as written, at the route's own path with the route's own key, and that a turn naming it runs to its end.

const BINARY = "/usr/local/bin/opencode";
const cli = requires(existsSync(BINARY), "the OpenCode CLI at /usr/local/bin/opencode", {
    absentOnCi: "the OpenCode CLI is a feature pack of the sandbox image, which the daemon's suites do not run in",
});

interface Seen {
    readonly path: string;
    readonly authorization: string | undefined;
    readonly apiKey: string | undefined;
    readonly model: string;
}

const sse = (events: readonly (readonly [string | undefined, Record<string, unknown>])[]): string =>
    events.map(([event, data]) => `${event === undefined ? "" : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`).join("");

// One short text reply in each wire's own stream shape.
const chatReply = (model: string): string =>
    `${sse([
        [undefined, { id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] }],
        [undefined, { id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }],
    ])}data: [DONE]\n\n`;

const responsesReply = (model: string): string => {
    const message = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] };
    const response = { id: "resp_1", object: "response", created_at: 1, model, status: "completed", output: [message], incomplete_details: null };
    return sse([
        ["response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } }],
        ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } }],
        ["response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "done" }],
        ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: message }],
        [
            "response.completed",
            {
                type: "response.completed",
                response: { ...response, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } },
            },
        ],
    ]);
};

const messagesReply = (model: string): string =>
    sse([
        ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
        ["message_stop", { type: "message_stop" }],
    ]);

const REPLIES: readonly (readonly [RegExp, (model: string) => string])[] = [
    [/\/chat\/completions$/, chatReply],
    [/\/responses$/, responsesReply],
    [/\/messages$/, messagesReply],
];

// Answers every wire at once, recording where each request went and with which key.
const servedModels = async () => {
    const seen: Seen[] = [];
    const answer = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        let body = "";
        for await (const chunk of request) {
            body += String(chunk);
        }
        const path = request.url ?? "";
        const reply = REPLIES.find(([pattern]) => pattern.test(path))?.[1];
        if (reply === undefined) {
            response.writeHead(404).end();
            return;
        }
        // SAFETY: each bundled package sends a JSON body naming its model; this test reads only that field.
        const { model } = JSON.parse(body) as { readonly model: string };
        const header = (name: string): string | undefined => {
            const value = request.headers[name];
            return Array.isArray(value) ? value[0] : value;
        };
        seen.push({ path, authorization: header("authorization"), apiKey: header("x-api-key"), model });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(reply(model));
    };
    const server: Server = createServer((request, response) => void answer(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port reports its address as an AddressInfo, never a pipe path.
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${String(port)}`, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};

let served: Awaited<ReturnType<typeof servedModels>>;
let dir = "";
let service: OpenCodeService;
const cards = parkedCards(memoryFleet().conversations);

const entry = (id: string, wire: OpenCodeRouteEntry["wire"], path: string, token: string, model: string): OpenCodeRouteEntry => ({
    id,
    provider: "kimi",
    label: id,
    wire,
    base: served.base,
    path,
    token,
    shield: "kimi",
    models: [{ id: model }],
});

beforeAll(async () => {
    if (!cli.runs) {
        return;
    }
    served = await servedModels();
    dir = await mkdtemp(join(tmpdir(), "opencode-hosted-"));
    const routes = [
        entry("intentic-route-chat", "openai-chat", "/api/coding/paas/v4", "chat-key", "glm-test"),
        entry("intentic-route-responses", "openai-responses", "/v1", "responses-key", "gpt-test"),
        entry("intentic-route-messages", "anthropic-messages", "/v1", "messages-key", "claude-test"),
    ];
    service = createOpenCodeService(join(dir, "xdg"), { idleStopMs: 0, shellDir: join(dir, "shell"), routes: async () => routes });
});

afterAll(async () => {
    if (!cli.runs) {
        return;
    }
    await service.stop();
    await served.close();
    await rm(dir, { recursive: true, force: true });
});

const turn = (providerID: string, model: string): AgentRequest<OpenCodeCredential> => ({
    execution: unstubbed("execution", {}),
    spec: { prompt: "say done", cwd: dir, model, conversationId: `hosted-${providerID}` },
    policy: {},
    tools: {},
    credential: { kind: "opencode-route", providerID },
    hooks: { cards },
    signal: new AbortController().signal,
});

const run = async (request: AgentRequest<OpenCodeCredential>): Promise<AgentEvent[]> => {
    const agent = createOpenCodeAgent(createOpenCodeRunner(service, { inactivityMs: 30_000, maxTurnMs: 90_000 }));
    const frames: AgentEvent[] = [];
    for await (const frame of agent(request)) {
        frames.push(frame);
    }
    return frames;
};

// One turn on a route's entry: the first request it sent, and the frames the turn ended on.
const turnOn = async (providerID: string, model: string): Promise<{ readonly request: Seen | undefined; readonly frames: AgentEvent[] }> => {
    const before = served.seen.length;
    const frames = await run(turn(providerID, model));
    return { request: served.seen[before], frames };
};

const ranToItsEnd = (frames: readonly AgentEvent[]): boolean =>
    frames.every((frame) => frame.kind !== "error") && frames.some((frame) => frame.kind === "delta") && frames.at(-1)?.kind === "done";

test.skipIf(!cli.runs)(cli.title("Chat Completions: the entry's versioned root, its bearer, and a turn that runs to its end"), async () => {
    const { request, frames } = await turnOn("intentic-route-chat", "glm-test");
    expect(request).toEqual({ path: "/api/coding/paas/v4/chat/completions", authorization: "Bearer chat-key", apiKey: undefined, model: "glm-test" });
    expect(ranToItsEnd(frames)).toBe(true);
}, 120_000);

test.skipIf(!cli.runs)(cli.title("Responses: the entry's versioned root, its bearer, and a turn that runs to its end"), async () => {
    const { request, frames } = await turnOn("intentic-route-responses", "gpt-test");
    expect(request).toEqual({ path: "/v1/responses", authorization: "Bearer responses-key", apiKey: undefined, model: "gpt-test" });
    expect(ranToItsEnd(frames)).toBe(true);
}, 120_000);

test.skipIf(!cli.runs)(cli.title("Anthropic Messages: the entry's root, its key as Anthropic sends one, and a turn that runs to its end"), async () => {
    const { request, frames } = await turnOn("intentic-route-messages", "claude-test");
    expect(request).toMatchObject({ path: "/v1/messages", apiKey: "messages-key", model: "claude-test" });
    expect(ranToItsEnd(frames)).toBe(true);
}, 120_000);
