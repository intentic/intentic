import type { RestoreText } from "../shield-types.js";
import { createHoldback, type Holdback } from "./holdback.js";
import { restoreJsonText } from "./json-text.js";
import { jsonEvent, type SseEvent, type SseHandler } from "./sse.js";
import { isList, isRecord, isText, type Json, type JsonObject, mapSame, parseJson, patch, restoreField, restoreStrings, typeOf } from "./walk.js";

// Tokens back to values in what the model wrote, for Codex to act on: message text, function arguments, custom tool
// input, shell commands. Reasoning items are the provider's encrypted state and stay exactly as they came.

type FieldRestore = (value: Json, restore: RestoreText) => Json;

const text: FieldRestore = (value, restore) => (isText(value) ? restore(value) : value);
const jsonText: FieldRestore = (value, restore) => (isText(value) ? restoreJsonText(value, restore) : value);
const strings: FieldRestore = (value, restore) => restoreStrings(value, restore);

const fieldsOf = (value: Json, restore: RestoreText, fields: Readonly<Record<string, FieldRestore>>): Json => {
    if (!isRecord(value)) {
        return value;
    }
    return Object.entries(fields).reduce<JsonObject>((object, [key, change]) => {
        const field = object[key];
        return field === undefined ? object : patch(object, key, change(field, restore));
    }, value);
};

// Only what the model wrote as its answer: a refusal is the provider's, and a reasoning part is its private state.
const restorePart = (part: Json, restore: RestoreText): Json =>
    isRecord(part) && typeOf(part) === "output_text" ? restoreField(part, "text", restore) : part;
const parts: FieldRestore = (value, restore) => (isList(value) ? mapSame(value, (part) => restorePart(part, restore)) : value);

const ITEM_FIELDS: ReadonlyMap<Json | undefined, Readonly<Record<string, FieldRestore>>> = new Map([
    ["message", { content: parts }],
    ["function_call", { arguments: jsonText }],
    ["custom_tool_call", { input: text }],
    [
        "local_shell_call",
        { action: (value: Json, restore: RestoreText) => fieldsOf(value, restore, { command: strings, env: strings, working_directory: text }) },
    ],
    ["shell_call", { action: (value: Json, restore: RestoreText) => fieldsOf(value, restore, { commands: strings }) }],
    ["apply_patch_call", { operation: (value: Json, restore: RestoreText) => fieldsOf(value, restore, { path: text, diff: text }) }],
    ["mcp_call", { arguments: jsonText }],
    ["mcp_approval_request", { arguments: jsonText }],
]);

const restoreItem = (item: Json, restore: RestoreText): Json => {
    const fields = ITEM_FIELDS.get(typeOf(item));
    return fields === undefined ? item : fieldsOf(item, restore, fields);
};

export const restoreResponsesResponse = (body: Json, restore: RestoreText): Json => {
    if (!isRecord(body)) {
        return body;
    }
    const output = body["output"];
    const restored = isList(output)
        ? patch(
              body,
              "output",
              mapSame(output, (item) => restoreItem(item, restore)),
          )
        : body;
    return restoreField(restored, "output_text", restore);
};

// The argument-like deltas a stream carries, by event: the field the delta writes, the field its `.done` writes, and
// whether the text is JSON.
interface Streamed {
    readonly delta: string;
    readonly doneField: string;
    readonly json: boolean;
}
const STREAMED: ReadonlyMap<string, Streamed> = new Map([
    ["response.function_call_arguments", { delta: "response.function_call_arguments.delta", doneField: "arguments", json: true }],
    ["response.custom_tool_call_input", { delta: "response.custom_tool_call_input.delta", doneField: "input", json: false }],
    ["response.mcp_call_arguments", { delta: "response.mcp_call_arguments.delta", doneField: "arguments", json: true }],
]);

interface HeldText {
    readonly holdback: Holdback;
    readonly item: string;
    // The ids a synthetic delta for this text copies.
    readonly ids: JsonObject;
}

interface HeldCall {
    readonly kind: Streamed;
    readonly item: string;
    readonly ids: JsonObject;
    readonly text: string;
}

// A held call let go: the one delta that replaces its fragments, and its restored whole for the `.done` to carry.
interface FlushedCall {
    readonly events: readonly SseEvent[];
    readonly full: string | undefined;
}

const pick = (payload: JsonObject, keys: readonly string[]): JsonObject =>
    Object.fromEntries(keys.flatMap((key) => (payload[key] === undefined ? [] : [[key, payload[key]] as const])));

const itemKey = (payload: JsonObject): string => {
    const id = payload["item_id"];
    return isText(id) ? id : `#${String(payload["output_index"])}`;
};

const reissue = (event: SseEvent, payload: JsonObject, next: Json): SseEvent => (next === payload ? event : jsonEvent(event.event, next));

const synthetic = (type: string, fields: JsonObject): SseEvent => jsonEvent(type, { type, ...fields });

// The stream, event by event. Text deltas pass through a holdback per content part; argument deltas are held whole
// and sent as one delta just before their `.done`, since a client may parse partial JSON and act on a half-restored
// value. Items and the response snapshots are restored like the JSON body.
export const responsesStreamRestorer = (restore: RestoreText): SseHandler => {
    const texts = new Map<string, HeldText>();
    const calls = new Map<string, HeldCall>();

    const flushText = (key: string, sequence: JsonObject): readonly SseEvent[] => {
        const held = texts.get(key);
        texts.delete(key);
        const tail = held?.holdback.flush() ?? "";
        return held === undefined || tail === "" ? [] : [synthetic("response.output_text.delta", { ...held.ids, delta: tail, ...sequence })];
    };

    // `kind` comes from the `.done` event when there is one, so a call that streamed no deltas is still read right.
    const flushCall = (key: string, kind: Streamed | undefined, done: string | undefined, sequence: JsonObject): FlushedCall => {
        const held = calls.get(key);
        calls.delete(key);
        const raw = done ?? held?.text;
        const json = (kind ?? held?.kind)?.json ?? true;
        const full = raw === undefined ? undefined : json ? restoreJsonText(raw, restore) : restore(raw);
        const events = held === undefined || full === undefined ? [] : [synthetic(held.kind.delta, { ...held.ids, delta: full, ...sequence })];
        return { events, full };
    };

    // Whatever an item still holds, for an item (or the whole response) that ended without its `.done` events.
    const flushItem = (item: string | undefined, sequence: JsonObject): readonly SseEvent[] => [
        ...[...texts].filter(([, held]) => item === undefined || held.item === item).flatMap(([key]) => flushText(key, sequence)),
        ...[...calls]
            .filter(([, held]) => item === undefined || held.item === item)
            .flatMap(([key]) => flushCall(key, undefined, undefined, sequence).events),
    ];

    const textDelta = (event: SseEvent, payload: JsonObject): readonly SseEvent[] => {
        const key = `${itemKey(payload)}:${String(payload["content_index"])}`;
        const held = texts.get(key) ?? {
            holdback: createHoldback(restore),
            item: itemKey(payload),
            ids: pick(payload, ["item_id", "output_index", "content_index"]),
        };
        texts.set(key, held);
        const delta = payload["delta"];
        if (!isText(delta)) {
            return [event];
        }
        const ready = held.holdback.push(delta);
        return ready === "" ? [] : [reissue(event, payload, patch(payload, "delta", ready))];
    };

    const textDone = (event: SseEvent, payload: JsonObject): readonly SseEvent[] => [
        ...flushText(`${itemKey(payload)}:${String(payload["content_index"])}`, pick(payload, ["sequence_number"])),
        reissue(event, payload, restoreField(payload, "text", restore)),
    ];

    const callDelta = (payload: JsonObject, kind: Streamed): readonly SseEvent[] => {
        const key = itemKey(payload);
        const delta = payload["delta"];
        const held = calls.get(key);
        calls.set(key, {
            kind,
            item: key,
            ids: held?.ids ?? pick(payload, ["item_id", "output_index"]),
            text: (held?.text ?? "") + (isText(delta) ? delta : ""),
        });
        return [];
    };

    const callDone = (event: SseEvent, payload: JsonObject, kind: Streamed): readonly SseEvent[] => {
        const done = payload[kind.doneField];
        const { events, full } = flushCall(itemKey(payload), kind, isText(done) ? done : undefined, pick(payload, ["sequence_number"]));
        return [...events, reissue(event, payload, isText(done) && full !== undefined ? patch(payload, kind.doneField, full) : payload)];
    };

    const snapshot = (event: SseEvent, payload: JsonObject, terminal: boolean): readonly SseEvent[] => {
        const response = payload["response"];
        const restored = response === undefined ? payload : patch(payload, "response", restoreResponsesResponse(response, restore));
        return [...(terminal ? flushItem(undefined, pick(payload, ["sequence_number"])) : []), reissue(event, payload, restored)];
    };

    const onPayload = (event: SseEvent, payload: JsonObject, type: string): readonly SseEvent[] => {
        const item = payload["item"];
        const part = payload["part"];
        const sequence = pick(payload, ["sequence_number"]);
        switch (type) {
            case "response.output_text.delta":
                return textDelta(event, payload);
            case "response.output_text.done":
                return textDone(event, payload);
            case "response.output_item.added":
                return [reissue(event, payload, item === undefined ? payload : patch(payload, "item", restoreItem(item, restore)))];
            case "response.output_item.done": {
                const id = isRecord(item) ? item["id"] : undefined;
                const restored = item === undefined ? payload : patch(payload, "item", restoreItem(item, restore));
                return [...(isText(id) ? flushItem(id, sequence) : []), reissue(event, payload, restored)];
            }
            case "response.content_part.added":
            case "response.content_part.done":
                return [reissue(event, payload, part === undefined ? payload : patch(payload, "part", restorePart(part, restore)))];
            case "response.created":
            case "response.in_progress":
            case "response.queued":
                return snapshot(event, payload, false);
            case "response.completed":
            case "response.incomplete":
            case "response.failed":
                return snapshot(event, payload, true);
            default:
                return [event];
        }
    };

    return {
        onEvent: (event) => {
            const payload = event.data === undefined ? undefined : parseJson(event.data);
            const type = typeOf(payload);
            if (!isRecord(payload) || !isText(type)) {
                return [event];
            }
            const [, stem, phase] = /^(.+)\.(delta|done)$/u.exec(type) ?? [];
            const kind = stem === undefined ? undefined : STREAMED.get(stem);
            if (kind === undefined) {
                return onPayload(event, payload, type);
            }
            return phase === "delta" ? callDelta(payload, kind) : callDone(event, payload, kind);
        },
        onEnd: () => flushItem(undefined, {}),
    };
};
