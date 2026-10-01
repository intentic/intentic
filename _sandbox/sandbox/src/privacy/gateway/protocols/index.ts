import type { RequestShield, RestoreText } from "../shield-types.js";
import { shieldAnthropicRequest } from "./anthropic-request.js";
import { anthropicStreamRestorer, restoreAnthropicResponse } from "./anthropic-response.js";
import { shieldChatRequest } from "./chat-request.js";
import { chatStreamRestorer, restoreChatResponse } from "./chat-response.js";
import { shieldResponsesRequest } from "./responses-request.js";
import { responsesStreamRestorer, restoreResponsesResponse } from "./responses-response.js";
import { type SseHandler, sseTransform } from "./sse.js";
import { type Json, toJson } from "./walk.js";

// The three wire formats the privacy gateway stands in front of, as pure transforms: a request body out (masked), a
// response body or event stream back (restored). The route, the masker and the vault live elsewhere; these only know
// where each format keeps the text the model reads and writes.

export type GatewayProtocol = "anthropic" | "responses" | "chat";
export type { Json } from "./walk.js";

// By the path after the gateway's prefix. Codex calls the Responses API with and without `/v1`, and asks it to compact
// a conversation or count its tokens under `/responses/…`: the same body shape, so the same walk.
const PROTOCOLS: ReadonlyMap<string, GatewayProtocol> = new Map([
    ["/v1/messages", "anthropic"],
    ["/v1/messages/count_tokens", "anthropic"],
    ["/v1/responses", "responses"],
    ["/responses", "responses"],
    ["/v1/responses/compact", "responses"],
    ["/responses/compact", "responses"],
    ["/v1/responses/input_tokens", "responses"],
    ["/responses/input_tokens", "responses"],
    ["/v1/chat/completions", "chat"],
    ["/chat/completions", "chat"],
]);

export const protocolOf = (path: string): GatewayProtocol | undefined => PROTOCOLS.get(path.split("?", 1)[0] ?? path);

// A new body with every string that carries conversation masked, binaries shown to the shield, and the note appended
// to the instructions. Never edits `body`. Throws a TypeError for a value JSON.parse could not have produced.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the gateway's parsed HTTP body is this module's I/O boundary.
export const shieldRequest = async (protocol: GatewayProtocol, body: unknown, shield: RequestShield): Promise<Json> => {
    const json = toJson(body);
    switch (protocol) {
        case "anthropic":
            return shieldAnthropicRequest(json, shield);
        case "responses":
            return shieldResponsesRequest(json, shield);
        case "chat":
            return shieldChatRequest(json, shield);
    }
};

// A non-streamed response with tokens restored in what the model wrote. Unchanged parts are the original objects.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the gateway's parsed HTTP body is this module's I/O boundary.
export const restoreResponse = (protocol: GatewayProtocol, body: unknown, restore: RestoreText): Json => {
    const json = toJson(body);
    switch (protocol) {
        case "anthropic":
            return restoreAnthropicResponse(json, restore);
        case "responses":
            return restoreResponsesResponse(json, restore);
        case "chat":
            return restoreChatResponse(json, restore);
    }
};

const restorers = {
    anthropic: anthropicStreamRestorer,
    responses: responsesStreamRestorer,
    chat: chatStreamRestorer,
} satisfies Readonly<Record<GatewayProtocol, (restore: RestoreText) => SseHandler>>;

// A Server-Sent-Events body with tokens restored as it streams. Each call gives a fresh transform with its own state.
export const restoreStream = (protocol: GatewayProtocol, restore: RestoreText): TransformStream<Uint8Array, Uint8Array> =>
    sseTransform(restorers[protocol](restore));
