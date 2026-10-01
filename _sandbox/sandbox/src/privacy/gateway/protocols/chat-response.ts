import type { RestoreText } from "../shield-types.js";
import { createHoldback, type Holdback } from "./holdback.js";
import { restoreJsonText } from "./json-text.js";
import { jsonEvent, type SseEvent, type SseHandler } from "./sse.js";
import { isCount, isList, isRecord, isText, type Json, type JsonObject, mapSame, parseJson, patch, restoreField, typeOf } from "./walk.js";

// Tokens back to values in what the model wrote, for OpenCode to act on: the message text and its tool calls'
// arguments. Reasoning a provider returns stays as it came, since some providers want it sent back unchanged.

const restoreCall = (call: Json, restore: RestoreText): Json => {
    const fn = isRecord(call) ? call["function"] : undefined;
    const args = isRecord(fn) ? fn["arguments"] : undefined;
    return isRecord(call) && isRecord(fn) && isText(args) ? patch(call, "function", patch(fn, "arguments", restoreJsonText(args, restore))) : call;
};

const restorePart = (part: Json, restore: RestoreText): Json =>
    isRecord(part) && typeOf(part) === "text" ? restoreField(part, "text", restore) : part;

const restoreMessage = (message: Json, restore: RestoreText): Json => {
    if (!isRecord(message)) {
        return message;
    }
    const content = message["content"];
    const calls = message["tool_calls"];
    const legacy = message["function_call"];
    const withContent = patch(
        message,
        "content",
        isText(content) ? restore(content) : isList(content) ? mapSame(content, (part) => restorePart(part, restore)) : content,
    );
    const withCalls = isList(calls)
        ? patch(
              withContent,
              "tool_calls",
              mapSame(calls, (call) => restoreCall(call, restore)),
          )
        : withContent;
    const legacyArgs = isRecord(legacy) ? legacy["arguments"] : undefined;
    return isRecord(legacy) && isText(legacyArgs)
        ? patch(withCalls, "function_call", patch(legacy, "arguments", restoreJsonText(legacyArgs, restore)))
        : withCalls;
};

export const restoreChatResponse = (body: Json, restore: RestoreText): Json => {
    const choices = isRecord(body) ? body["choices"] : undefined;
    if (!isRecord(body) || !isList(choices)) {
        return body;
    }
    return patch(
        body,
        "choices",
        mapSame(choices, (choice) =>
            isRecord(choice) && choice["message"] !== undefined ? patch(choice, "message", restoreMessage(choice["message"], restore)) : choice,
        ),
    );
};

// What one choice still holds: text that may end in half a token, and every tool call's arguments so far.
interface Held {
    readonly text: Holdback;
    readonly args: Map<number, string>;
}

const pick = (payload: JsonObject, keys: readonly string[]): JsonObject =>
    Object.fromEntries(keys.flatMap((key) => (payload[key] === undefined ? [] : [[key, payload[key]] as const])));

const omit = (payload: JsonObject, key: string): JsonObject => Object.fromEntries(Object.entries(payload).filter(([name]) => name !== key));

// A delta that still says something: any field but an empty or null one.
const hasPayload = (delta: Json | undefined): boolean =>
    isRecord(delta) && Object.values(delta).some((value) => value !== null && value !== "" && !(isList(value) && value.length === 0));

const finishes = (choice: Json): boolean =>
    isRecord(choice) && choice["finish_reason"] !== undefined && choice["finish_reason"] !== null && isCount(choice["index"]);

// The stream, chunk by chunk. Content passes through a holdback per choice. Tool call arguments are held whole and
// sent as ONE fragment just before the choice finishes: the Vercel AI SDK (OpenCode) treats a call as complete the
// moment its arguments parse as JSON, so a partial-but-parsable prefix must never reach it. The chunks that open a
// call keep flowing, with empty arguments, so the client still learns the call's id and name as early as before.
export const chatStreamRestorer = (restore: RestoreText): SseHandler => {
    const choices = new Map<number, Held>();
    let envelope: JsonObject = {};

    const heldOf = (index: number): Held => {
        const known = choices.get(index);
        if (known !== undefined) {
            return known;
        }
        const created: Held = { text: createHoldback(restore), args: new Map() };
        choices.set(index, created);
        return created;
    };

    const flush = (index: number): readonly SseEvent[] => {
        const held = choices.get(index);
        choices.delete(index);
        const tail = held?.text.flush() ?? "";
        const calls = [...(held?.args ?? [])].map(([call, raw]) => ({ index: call, function: { arguments: restoreJsonText(raw, restore) } }));
        if (tail === "" && calls.length === 0) {
            return [];
        }
        const delta = Object.fromEntries([
            ...(tail === "" ? [] : [["content", tail] as const]),
            ...(calls.length === 0 ? [] : [["tool_calls", calls] as const]),
        ]);
        return [jsonEvent(undefined, { ...envelope, choices: [{ index, delta, finish_reason: null }] })];
    };

    const flushAll = (): readonly SseEvent[] => [...choices.keys()].toSorted((a, b) => a - b).flatMap(flush);

    // One tool call delta: its argument fragment kept back, the rest (index, id, type, name) sent on.
    const holdCall = (call: Json, position: number, held: Held): readonly Json[] => {
        const fn = isRecord(call) ? call["function"] : undefined;
        const args = isRecord(fn) ? fn["arguments"] : undefined;
        if (!isRecord(call) || !isRecord(fn) || !isText(args)) {
            return [call];
        }
        const index = isCount(call["index"]) ? call["index"] : position;
        held.args.set(index, (held.args.get(index) ?? "") + args);
        const opens = Object.keys(call).some((key) => key !== "index" && key !== "function") || Object.keys(fn).some((key) => key !== "arguments");
        return opens ? [patch(call, "function", patch(fn, "arguments", ""))] : [];
    };

    const restoreDelta = (delta: JsonObject, held: Held): JsonObject => {
        const content = delta["content"];
        const calls = delta["tool_calls"];
        const ready = isText(content) && content !== "" ? held.text.push(content) : content;
        const withContent = ready === "" && content !== "" ? omit(delta, "content") : patch(delta, "content", ready);
        if (!isList(calls)) {
            return withContent;
        }
        const kept = calls.flatMap((call, position) => holdCall(call, position, held));
        return kept.length === 0 ? omit(withContent, "tool_calls") : { ...withContent, tool_calls: kept };
    };

    const restoreChoice = (choice: Json): Json => {
        const delta = isRecord(choice) ? choice["delta"] : undefined;
        const index = isRecord(choice) ? choice["index"] : undefined;
        return isRecord(choice) && isRecord(delta) && isCount(index) ? patch(choice, "delta", restoreDelta(delta, heldOf(index))) : choice;
    };

    // A chunk that finishes a choice whose tail was held: its own delta first (minus the finish), then the tail, then the
    // finish on an empty delta, so the client has every byte of the choice before it learns the choice is over.
    const finish = (event: SseEvent, chunk: JsonObject, original: readonly Json[], restored: readonly Json[]): readonly SseEvent[] => {
        const ending = restored.filter((choice) => finishes(choice));
        const tails = ending.flatMap((choice) => (isRecord(choice) && isCount(choice["index"]) ? flush(choice["index"]) : []));
        if (tails.length === 0) {
            return restored === original ? [event] : [jsonEvent(undefined, patch(chunk, "choices", restored))];
        }
        const leading = restored.flatMap((choice) => {
            if (!finishes(choice) || !isRecord(choice)) {
                return [choice];
            }
            return hasPayload(choice["delta"]) ? [{ ...choice, finish_reason: null }] : [];
        });
        const lead = leading.some((choice) => isRecord(choice) && hasPayload(choice["delta"]))
            ? [jsonEvent(undefined, { ...omit(chunk, "usage"), choices: leading })]
            : [];
        const finished = ending.map((choice) => (isRecord(choice) ? { ...choice, delta: {} } : choice));
        return [...lead, ...tails, jsonEvent(undefined, { ...chunk, choices: finished })];
    };

    const onChunk = (event: SseEvent, chunk: JsonObject): readonly SseEvent[] => {
        const list = chunk["choices"];
        if (!isList(list)) {
            return [event];
        }
        envelope = pick(chunk, ["id", "object", "created", "model"]);
        const restored = mapSame(list, restoreChoice);
        if (restored.some((choice) => finishes(choice))) {
            return finish(event, chunk, list, restored);
        }
        // A chunk whose every delta was held back says nothing now; it is dropped rather than sent empty.
        const emptied = restored.every((choice, at) => {
            const before = list[at];
            return isRecord(before) && isRecord(choice) && hasPayload(before["delta"]) && !hasPayload(choice["delta"]);
        });
        if (emptied && restored.length > 0 && chunk["usage"] === undefined) {
            return [];
        }
        return restored === list ? [event] : [jsonEvent(undefined, patch(chunk, "choices", restored))];
    };

    return {
        onEvent: (event) => {
            if (event.data?.trim() === "[DONE]") {
                return [...flushAll(), event];
            }
            const chunk = event.data === undefined ? undefined : parseJson(event.data);
            return isRecord(chunk) ? onChunk(event, chunk) : [event];
        },
        onEnd: flushAll,
    };
};
