import type { RequestShield, ShieldBinary } from "../shield-types.js";
import { maskJsonText } from "./json-text.js";
import {
    binaryOfUrl,
    isList,
    isRecord,
    isText,
    type Json,
    type JsonObject,
    mapAll,
    maskField,
    maskStrings,
    maskText,
    patch,
    typeOf,
    withNote,
} from "./walk.js";

// The OpenAI Responses API as Codex sends it (`/v1/responses`). `instructions` and `input` carry the conversation;
// `tools`, `reasoning`, `include` and the rest go as sent. Reasoning items hold the provider's own encrypted state,
// so they go back exactly as they came.

type FieldMask = (value: Json, shield: RequestShield) => Promise<Json>;

const text: FieldMask = async (value, shield) => (isText(value) ? maskText(value, shield.mask) : value);
const jsonText: FieldMask = async (value, shield) => (isText(value) ? maskJsonText(value, shield.mask) : value);

// A file the shield is shown: a data URL, raw base64 (a PDF is the only file type Responses reads inline), or a URL.
const fileBinary = (part: JsonObject): ShieldBinary | undefined => {
    const data = part["file_data"];
    const url = part["file_url"];
    if (isText(data)) {
        return data.startsWith("data:") ? binaryOfUrl(data) : { mediaType: "application/pdf", data };
    }
    return isText(url) ? { mediaType: "url", data: url } : undefined;
};

// `image_url` is a string here; the object form Chat Completions uses is read too, for a client that mixes them.
const imageUrl = (part: JsonObject): string | undefined => {
    const url = part["image_url"];
    const nested = isRecord(url) ? url["url"] : url;
    return isText(nested) ? nested : undefined;
};

export const walkPart = async (part: Json, shield: RequestShield): Promise<Json> => {
    if (!isRecord(part)) {
        return part;
    }
    switch (typeOf(part)) {
        case "input_text":
        case "output_text":
            return maskField(part, "text", shield.mask);
        case "input_image": {
            const url = imageUrl(part);
            // An image named only by a file id is the provider's own copy; there is nothing here to inspect.
            const verdict = url === undefined ? "keep" : await shield.image(binaryOfUrl(url));
            return verdict === "keep" ? part : { type: "input_text", text: verdict.text };
        }
        case "input_file": {
            const binary = fileBinary(part);
            const verdict = binary === undefined ? "keep" : await shield.document(binary);
            // A file name is as likely to hold a person's name as the file is.
            return verdict === "keep" ? maskField(part, "filename", shield.mask) : { type: "input_text", text: verdict.text };
        }
        default:
            return part;
    }
};

const output: FieldMask = async (value, shield) => {
    if (isText(value)) {
        return maskText(value, shield.mask);
    }
    return isList(value) ? mapAll(value, async (part) => walkPart(part, shield)) : value;
};

const fieldsOf = async (value: Json, shield: RequestShield, fields: Readonly<Record<string, FieldMask>>): Promise<Json> => {
    if (!isRecord(value)) {
        return value;
    }
    const changed = await Promise.all(
        Object.entries(fields).map(async ([key, change]) => {
            const field = value[key];
            return [key, field === undefined ? undefined : await change(field, shield)] as const;
        }),
    );
    return changed.reduce<JsonObject>((object, [key, field]) => patch(object, key, field), value);
};

const strings: FieldMask = async (value, shield) => maskStrings(value, shield.mask);

// Codex's own shell tool: the argv, its environment's values and the directory it runs in.
const localShellAction: FieldMask = async (value, shield) => fieldsOf(value, shield, { command: strings, env: strings, working_directory: text });
const shellAction: FieldMask = async (value, shield) => fieldsOf(value, shield, { commands: strings });
const shellOutputs: FieldMask = async (value, shield) =>
    isList(value) ? mapAll(value, async (entry) => fieldsOf(entry, shield, { stdout: text, stderr: text })) : value;
const patchOperation: FieldMask = async (value, shield) => fieldsOf(value, shield, { path: text, diff: text });

// What each item type carries that the model or a tool wrote. Ids, call ids and statuses are never masked: a masker that
// mistook `call_8312` for an account number would orphan the call from its output.
const ITEM_FIELDS: ReadonlyMap<Json | undefined, Readonly<Record<string, FieldMask>>> = new Map([
    ["message", { content: output }],
    ["function_call", { arguments: jsonText }],
    ["function_call_output", { output }],
    ["custom_tool_call", { input: text }],
    ["custom_tool_call_output", { output }],
    ["local_shell_call", { action: localShellAction }],
    ["local_shell_call_output", { output: text }],
    ["shell_call", { action: shellAction }],
    ["shell_call_output", { output: shellOutputs }],
    ["apply_patch_call", { operation: patchOperation }],
    ["apply_patch_call_output", { output: text }],
    ["mcp_call", { arguments: jsonText, output: text, error: text }],
    ["mcp_approval_request", { arguments: jsonText }],
]);

export const walkItem = async (item: Json, shield: RequestShield): Promise<Json> => {
    if (!isRecord(item)) {
        return item;
    }
    // A message may be written `{role, content}` with no type at all.
    const type = typeOf(item) ?? (isText(item["role"]) ? "message" : undefined);
    const fields = ITEM_FIELDS.get(type);
    return fields === undefined ? item : fieldsOf(item, shield, fields);
};

const walkInstructions = async (instructions: Json | undefined, shield: RequestShield): Promise<Json | undefined> => {
    const { note } = shield;
    if (isText(instructions)) {
        const masked = await maskText(instructions, shield.mask);
        return note === undefined ? masked : withNote(masked, note);
    }
    if (isList(instructions)) {
        const items = await mapAll(instructions, async (item) => walkItem(item, shield));
        return note === undefined ? items : [...items, { type: "message", role: "developer", content: note }];
    }
    return instructions === undefined || instructions === null ? note : instructions;
};

export const shieldResponsesRequest = async (body: Json, shield: RequestShield): Promise<Json> => {
    if (!isRecord(body)) {
        return body;
    }
    const input = body["input"];
    const instructions = await walkInstructions(body["instructions"], shield);
    const walked = isText(input)
        ? await maskText(input, shield.mask)
        : isList(input)
          ? await mapAll(input, async (item) => walkItem(item, shield))
          : input;
    // Always a fresh top-level object, so the gateway can set its own fields on what it sends without touching the original.
    return { ...patch(patch(body, "instructions", instructions), "input", walked) };
};
