import type { CoinedCall, RestoreText } from "../shield-types.js";
import { createHoldback, type Holdback } from "./holdback.js";
import { restoreJsonText } from "./json-text.js";
import { jsonEvent, type SseEvent, type SseHandler } from "./sse.js";
import {
    isCount,
    isList,
    isRecord,
    isText,
    type Json,
    type JsonObject,
    mapSame,
    parseJson,
    patch,
    restoreField,
    restoreStrings,
    typeOf,
} from "./walk.js";

// Tokens back to values in what the model wrote, for Claude Code to act on: text, and the inputs of the tools it
// calls. Thinking stays as signed, tokens and all, since the next request must send it back exactly.

const TOOL_BLOCKS: ReadonlySet<Json | undefined> = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);

// A tool call's input restored by `restoring`, and the call reported to `coined` by its id when the model made up a
// token in it.
const restoreCall = <T>(
    id: Json | undefined,
    coined: CoinedCall | undefined,
    restoring: (restore: (text: string) => string) => T,
    restore: RestoreText,
): T => {
    const found: string[] = [];
    const restored = restoring((text) => restore(text, (token) => found.push(token)));
    if (found.length > 0 && isText(id)) {
        coined?.(id, found);
    }
    return restored;
};

const restoreBlock = (block: Json, restore: RestoreText, coined?: CoinedCall): Json => {
    if (!isRecord(block)) {
        return block;
    }
    const type = typeOf(block);
    if (type === "text") {
        return restoreField(block, "text", restore);
    }
    const input = block["input"];
    return TOOL_BLOCKS.has(type) && input !== undefined
        ? patch(
              block,
              "input",
              restoreCall(block["id"], coined, (each) => restoreStrings(input, each), restore),
          )
        : block;
};

const restoreMessage = (message: Json, restore: RestoreText, coined?: CoinedCall): Json => {
    if (!isRecord(message)) {
        return message;
    }
    const content = message["content"];
    return isList(content)
        ? patch(
              message,
              "content",
              mapSame(content, (block) => restoreBlock(block, restore, coined)),
          )
        : message;
};

export const restoreAnthropicResponse = (message: Json, restore: RestoreText, coined?: CoinedCall): Json => restoreMessage(message, restore, coined);

// Rewritten when restoring changed it, else forwarded as the very text it came in as.
const reissue = (event: SseEvent, payload: JsonObject, next: JsonObject): SseEvent => (next === payload ? event : jsonEvent(event.event, next));

const textDelta = (index: number, text: string): SseEvent =>
    jsonEvent("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } });

const inputDelta = (index: number, json: string): SseEvent =>
    jsonEvent("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } });

// The stream, block by block. Text deltas pass through a holdback, so a token split across deltas is restored whole.
// Tool input is held back entirely and sent as ONE fragment at the block's end: restoring a fragment could change its
// length mid-string, and a client that parses partial JSON would act on a half-restored value. A call whose input held a
// made-up token is told to `coined` before its block ends, so it is known before the client can run it.
export const anthropicStreamRestorer = (restore: RestoreText, coined?: CoinedCall): SseHandler => {
    const texts = new Map<number, Holdback>();
    const inputs = new Map<number, string>();
    // Each open tool block's id, for `coined`.
    const ids = new Map<number, Json | undefined>();

    const textOf = (index: number): Holdback => {
        const known = texts.get(index);
        if (known !== undefined) {
            return known;
        }
        const created = createHoldback(restore);
        texts.set(index, created);
        return created;
    };

    // What a block still holds, as the deltas that finish it.
    const close = (index: number): readonly SseEvent[] => {
        const tail = texts.get(index)?.flush() ?? "";
        const json = inputs.get(index);
        const id = ids.get(index);
        texts.delete(index);
        inputs.delete(index);
        ids.delete(index);
        const input = json === undefined ? undefined : restoreCall(id, coined, (each) => restoreJsonText(json, each), restore);
        return [...(tail === "" ? [] : [textDelta(index, tail)]), ...(input === undefined ? [] : [inputDelta(index, input)])];
    };

    const closeAll = (): readonly SseEvent[] =>
        [...new Set([...texts.keys(), ...inputs.keys(), ...ids.keys()])].toSorted((a, b) => a - b).flatMap(close);

    const start = (event: SseEvent, payload: JsonObject, index: number): readonly SseEvent[] => {
        const block = payload["content_block"];
        if (typeOf(block) === "text" && isRecord(block)) {
            const text = block["text"];
            return [reissue(event, payload, patch(payload, "content_block", patch(block, "text", isText(text) ? textOf(index).push(text) : text)))];
        }
        if (TOOL_BLOCKS.has(typeOf(block)) && isRecord(block)) {
            ids.set(index, block["id"]);
        }
        return block === undefined ? [event] : [reissue(event, payload, patch(payload, "content_block", restoreBlock(block, restore, coined)))];
    };

    const delta = (event: SseEvent, payload: JsonObject, index: number): readonly SseEvent[] => {
        const change = payload["delta"];
        if (!isRecord(change)) {
            return [event];
        }
        const text = change["text"];
        const json = change["partial_json"];
        if (change["type"] === "text_delta" && isText(text)) {
            const ready = textOf(index).push(text);
            return ready === "" ? [] : [reissue(event, payload, patch(payload, "delta", patch(change, "text", ready)))];
        }
        if (change["type"] === "input_json_delta" && isText(json)) {
            inputs.set(index, (inputs.get(index) ?? "") + json);
            return [];
        }
        return [event];
    };

    return {
        onEvent: (event) => {
            const payload = event.data === undefined ? undefined : parseJson(event.data);
            if (!isRecord(payload)) {
                return [event];
            }
            const index = payload["index"];
            const message = payload["message"];
            switch (payload["type"]) {
                case "message_start":
                    return message === undefined
                        ? [event]
                        : [reissue(event, payload, patch(payload, "message", restoreMessage(message, restore, coined)))];
                case "content_block_start":
                    return isCount(index) ? start(event, payload, index) : [event];
                case "content_block_delta":
                    return isCount(index) ? delta(event, payload, index) : [event];
                case "content_block_stop":
                    return isCount(index) ? [...close(index), event] : [event];
                case "message_stop":
                    return [...closeAll(), event];
                default:
                    return [event];
            }
        },
        onEnd: closeAll,
    };
};
