import type { RequestShield, ShieldBinary } from "../shield-types.js";
import { maskJsonText } from "./json-text.js";
import { binaryOfUrl, dataUrl, isList, isRecord, isText, type Json, type JsonObject, mapAll, maskField, maskText, patch, typeOf, withNote } from "./walk.js";

// OpenAI Chat Completions as OpenCode sends it to an OpenAI-compatible provider (`/v1/chat/completions`). Only
// `messages` carries conversation; reasoning a provider returned (`reasoning_content`, `reasoning`) is its own state
// and goes back as it came, as do audio parts, which the shield has no reader for.

const imageUrl = (part: JsonObject): string | undefined => {
    const image = part["image_url"];
    const url = isRecord(image) ? image["url"] : image;
    return isText(url) ? url : undefined;
};

// `file_data` is a data URL, or raw base64 from a client that leaves the PDF media type implied.
const fileBinary = (file: JsonObject): ShieldBinary | undefined => {
    const data = file["file_data"];
    if (!isText(data)) {
        return undefined;
    }
    return data.startsWith("data:") ? binaryOfUrl(data) : { mediaType: "application/pdf", data };
};

const walkFile = async (part: JsonObject, shield: RequestShield): Promise<Json> => {
    const file = part["file"];
    if (!isRecord(file)) {
        return part;
    }
    const binary = fileBinary(file);
    // A file named only by its id is the provider's own copy; there is nothing here to inspect.
    const verdict = binary === undefined ? "keep" : await shield.document(binary);
    // A file name is as likely to hold a person's name as the file is.
    return verdict === "keep" ? patch(part, "file", await maskField(file, "filename", shield.mask)) : { type: "text", text: verdict.text };
};

const walkPart = async (part: Json, shield: RequestShield): Promise<Json> => {
    if (!isRecord(part)) {
        return part;
    }
    switch (typeOf(part)) {
        case "text":
            return maskField(part, "text", shield.mask);
        case "image_url": {
            const url = imageUrl(part);
            const verdict = url === undefined ? "keep" : await shield.image(binaryOfUrl(url));
            if (verdict === "keep") {
                return part;
            }
            if (!("image" in verdict)) {
                return { type: "text", text: verdict.text };
            }
            // The masked picture as a data URL, any `detail` the client asked for kept.
            const image = part["image_url"];
            return { ...part, image_url: { ...(isRecord(image) ? image : {}), url: dataUrl(verdict.image) } };
        }
        case "file":
            return walkFile(part, shield);
        default:
            return part;
    }
};

// A call the assistant made, its JSON arguments masked as text.
const walkCall = async (call: Json, shield: RequestShield): Promise<Json> => {
    const fn = isRecord(call) ? call["function"] : undefined;
    const args = isRecord(fn) ? fn["arguments"] : undefined;
    if (!isRecord(call) || !isRecord(fn) || !isText(args)) {
        return call;
    }
    return patch(call, "function", patch(fn, "arguments", await maskJsonText(args, shield.mask)));
};

const walkMessage = async (message: Json, shield: RequestShield): Promise<Json> => {
    if (!isRecord(message)) {
        return message;
    }
    const content = message["content"];
    const calls = message["tool_calls"];
    // The single `function_call` older clients still send in place of `tool_calls`.
    const legacy = message["function_call"];
    const walked = isText(content)
        ? await maskText(content, shield.mask)
        : isList(content)
          ? await mapAll(content, async (part) => walkPart(part, shield))
          : content;
    const withCalls = patch(
        patch(message, "content", walked),
        "tool_calls",
        isList(calls) ? await mapAll(calls, async (call) => walkCall(call, shield)) : calls,
    );
    if (!isRecord(legacy)) {
        return withCalls;
    }
    return patch(
        withCalls,
        "function_call",
        isText(legacy["arguments"]) ? patch(legacy, "arguments", await maskJsonText(legacy["arguments"], shield.mask)) : legacy,
    );
};

// Into the leading system (or developer) message when there is one, so the provider still sees a single system
// prompt; otherwise a system message of its own goes first.
const withChatNote = (messages: readonly Json[], note: string): readonly Json[] => {
    const [first, ...rest] = messages;
    const content = isRecord(first) ? first["content"] : undefined;
    if (isRecord(first) && (first["role"] === "system" || first["role"] === "developer")) {
        if (isText(content)) {
            return [patch(first, "content", withNote(content, note)), ...rest];
        }
        if (isList(content)) {
            return [patch(first, "content", [...content, { type: "text", text: note }]), ...rest];
        }
    }
    return [{ role: "system", content: note }, ...messages];
};

export const shieldChatRequest = async (body: Json, shield: RequestShield): Promise<Json> => {
    if (!isRecord(body)) {
        return body;
    }
    const messages = body["messages"];
    if (!isList(messages)) {
        return { ...body };
    }
    const walked = await mapAll(messages, async (message) => walkMessage(message, shield));
    // Always a fresh top-level object, so the gateway can set its own fields on what it sends without touching the original.
    return { ...body, messages: shield.note === undefined ? walked : withChatNote(walked, shield.note) };
};
